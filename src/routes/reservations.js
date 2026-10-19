const express = require('express');
const { makeTable, pool } = require('../db');
const { requireAdmin } = require('../auth');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { sendBookingConfirmation, sendAdminNewReservation, sendReservationUpdate, sendReminder, sendWaitlistNotice } = require('../email');
const { hasStarted, manilaDate } = require('../time');
const MAX_ACTIVE_SEATS = parseInt(process.env.MAX_ACTIVE_SEATS, 10) || 16; // upcoming seats one guest can hold
const { ticketCode, qrText } = require('../tickets');
const { sendBookingSms } = require('../sms');
const { movies: moviesTable } = require('./movies');

const { readRow: readSiteRow } = require('../site');
const router = express.Router();
const reservations = makeTable('reservations', () => []);
const waitlist = makeTable('waitlist', () => []);

/* ---- seat locks: the database refuses a second booking for the same seat ---- */
const lockKey = (r, seat) => `${r.movieId}|${r.date}|${r.time}|${seat}`;
async function applyLocks(r) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM seat_locks WHERE rid = $1', [r.id]);
    if (r.status === 'confirmed' && r.seats.length) {
      const keys = r.seats.map((s) => lockKey(r, s));
      const ins = await client.query(
        `INSERT INTO seat_locks (k, rid) SELECT k, $2 FROM unnest($1::text[]) AS k
         ON CONFLICT (k) DO NOTHING RETURNING k`, [keys, r.id]);
      if (ins.rowCount < keys.length) {
        await client.query('ROLLBACK');
        const e = new Error('seat conflict'); e.conflict = true; throw e;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
// Runs once per server start: rebuild locks from existing bookings and drop stale ones.
async function backfillSeatLocks() {
  await pool.query(`DELETE FROM seat_locks WHERE rid NOT IN (SELECT id FROM reservations WHERE data->>'status' = 'confirmed')`);
  await pool.query(`
    INSERT INTO seat_locks (k, rid)
    SELECT (r.data->>'movieId') || '|' || (r.data->>'date') || '|' || (r.data->>'time') || '|' || seat, r.id
    FROM reservations r, jsonb_array_elements_text(r.data->'seats') AS seat
    WHERE r.data->>'status' = 'confirmed'
    ON CONFLICT (k) DO NOTHING`);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G']; // 7 rows, A is closest to the screen
const SEATS_PER_ROW = 7; // 7 x 7 = 49 seats
const ALL_SEATS = ROWS.flatMap((r) => Array.from({ length: SEATS_PER_ROW }, (_, i) => r + (i + 1)));

function genId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

const hits = new Map();
function limited(key, max, windowMs) {
  if (process.env.DISABLE_RATE_LIMIT === '1') return false; // only for automated tests
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

// Philippine mobile (09XXXXXXXXX / +639XXXXXXXXX), Philippine landline with area code (045-625-9620, 02-8123-4567),
// or an international number (+ and 8-15 digits).
function cleanPhone(v) {
  const raw = String(v || '').trim();
  const digits = raw.replace(/[^\d+]/g, '');
  let m = /^(?:\+?63|0)(9\d{9})$/.exec(digits);
  if (m) return '0' + m[1];
  m = /^(?:\+?63|0)([2-8]\d{8,9})$/.exec(digits);
  if (m) return '0' + m[1];
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  return null;
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

function tokenOk(r, t) {
  if (!r || !r.ticketToken || typeof t !== 'string') return false;
  const a = Buffer.from(r.ticketToken);
  const b = Buffer.from(t);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Only what the ticket holder needs (no internal fields).
function publicView(r) {
  return {
    id: r.id,
    code: ticketCode(r),
    name: r.name,
    email: r.email,
    phone: r.phone || '',
    movieTitle: r.movieTitle,
    date: r.date,
    time: r.time,
    hall: r.hall,
    seats: r.seats,
    status: r.status,
    createdAt: r.createdAt,
    checkedInAt: r.checkedInAt || null,
  };
}

function takenSeats(list, movieId, date, time, excludeId) {
  return list
    .filter(
      (r) =>
        r.status === 'confirmed' &&
        r.movieId === movieId &&
        r.date === date &&
        r.time === time &&
        r.id !== excludeId
    )
    .flatMap((r) => r.seats);
}

function capacityOf(showtime) {
  return Math.min(49, Math.max(1, parseInt(showtime && showtime.capacity, 10) || 49));
}

// Tell people on the waitlist when seats free up for a showing (once each).
async function notifyWaitlist(movieId, date, time, url) {
  try {
    const entries = (await waitlist.all()).filter((w) => w.movieId === movieId && w.date === date && w.time === time && !w.notifiedAt);
    if (!entries.length || hasStarted(date, time)) return;
    const movie = (await moviesTable.all()).find((m) => m.id === movieId);
    const st = movie && movie.showtimes.find((x) => x.date === date && x.time === time);
    if (!st || st.closed) return;
    const taken = takenSeats(await reservations.all(), movieId, date, time).length;
    if (taken >= capacityOf(st)) return;
    for (const w of entries) {
      await sendWaitlistNotice(w, url).catch(() => null);
      w.notifiedAt = new Date().toISOString();
      await waitlist.put(w);
    }
  } catch (e) { console.warn('[waitlist]', e.message); }
}

// Public: how many seats are taken per showtime (counts only, no personal details).
router.get('/availability', async (_req, res) => {
  const counts = {};
  (await reservations.all())
    .filter((r) => r.status === 'confirmed')
    .forEach((r) => {
      const k = `${r.movieId}|${r.date}|${r.time}`;
      counts[k] = (counts[k] || 0) + r.seats.length;
    });
  res.json({ counts });
});

router.get('/seats', async (req, res) => {
  const { movieId, date, time } = req.query;
  if (!movieId || !date || !time) {
    return res.status(400).json({ error: 'movieId, date and time are required' });
  }
  const taken = takenSeats(await reservations.all(), movieId, date, time);
  res.json({ taken });
});

router.post('/', async (req, res) => {
  if (limited('book:' + req.ip, 12, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many reservations from this connection. Please try again later.' });
  }
  // Admin on/off switch for all reservations (Site Settings / staff panel).
  const siteRow = await readSiteRow();
  if (siteRow.bookingOpen === false) {
    return res.status(403).json({ error: siteRow.bookingClosedMessage || 'Reservations are closed right now.', closed: true });
  }
  const b = req.body || {};
  if (b.website) return res.status(400).json({ error: 'Could not send that reservation.' }); // hidden field: bots fill it in
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const phone = cleanPhone(b.phone);
  const { movieId, date, time } = b;
  if (EMAIL_RE.test(email) && limited('book-email:' + email, 6, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many reservations for this email. Please try again later.' });
  }
  const seats = Array.isArray(b.seats) ? b.seats : [];

  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number, like 0917 123 4567 or 045 625 9620.' });
  if (b.consent !== true) return res.status(400).json({ error: 'Please agree to the privacy notice to continue.' });
  if (!movieId || !date || !time) return res.status(400).json({ error: 'Missing showtime details.' });
  if (!seats.length || seats.length > 8) return res.status(400).json({ error: 'Pick between 1 and 8 seats.' });
  if (!seats.every((s) => ALL_SEATS.includes(s))) return res.status(400).json({ error: 'Invalid seat code.' });

  const movies = await moviesTable.all();
  const movie = movies.find((m) => m.id === movieId);
  if (!movie) return res.status(404).json({ error: 'Movie not found.' });
  const showtime = movie.showtimes.find((st) => st.date === date && st.time === time);
  if (!showtime) return res.status(404).json({ error: 'That showtime no longer exists.' });

  if (showtime.closed) return res.status(403).json({ error: 'Reservations for this showing are closed.', closed: true });
  if (hasStarted(date, time)) return res.status(400).json({ error: 'This showing has already started.' });

  const all = await reservations.all();
  const taken = takenSeats(all, movieId, date, time);
  const conflict = seats.some((s) => taken.includes(s));
  if (conflict) {
    return res.status(409).json({ error: 'One or more of those seats were just taken. Please reselect.', taken });
  }
  const holding = all
    .filter((r) => r.status === 'confirmed' && r.date >= manilaDate(0) && (r.email === email || (r.phone && r.phone === phone)))
    .reduce((n, r) => n + r.seats.length, 0);
  if (holding + seats.length > MAX_ACTIVE_SEATS) {
    return res.status(409).json({ error: `To keep seats fair for everyone, one guest can hold up to ${MAX_ACTIVE_SEATS} upcoming seats. Please contact CKS staff for a bigger group.` });
  }
  const room = capacityOf(showtime) - taken.length;
  if (seats.length > room) {
    return res.status(409).json({ error: room > 0 ? `Only ${room} seat${room === 1 ? '' : 's'} left for this showing.` : 'This showing is full.', taken });
  }

  const record = {
    id: genId('r'),
    name,
    email,
    phone,
    ticketToken: newToken(),
    movieId,
    movieTitle: movie.title,
    movieDuration: movie.duration || 120,
    date,
    time,
    hall: 'Main Hall',
    seats,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    consentAt: new Date().toISOString(),
    emailStatus: 'pending',
  };
  try {
    await applyLocks(record); // atomic: fails if another guest got a seat a moment ago
  } catch (e) {
    if (e.conflict) {
      const fresh = takenSeats(await reservations.all(), movieId, date, time);
      return res.status(409).json({ error: 'One or more of those seats were just taken. Please reselect.', taken: fresh });
    }
    throw e;
  }
  await reservations.put(record);

  // Notify the customer and the CKS admin. Awaited so it finishes before the serverless function is frozen.
  const [emailResult, smsResult] = await Promise.all([
    sendBookingConfirmation(record, appUrl(req)),
    sendBookingSms(record, ticketCode(record)).catch((e) => ({ sent: false, reason: 'error', message: e.message })),
    sendAdminNewReservation(record, appUrl(req)).catch(() => null),
  ]);
  record.emailStatus = emailResult.sent ? 'sent' : emailResult.reason === 'error' ? 'error' : 'not_sent';
  record.smsStatus = smsResult.sent ? 'sent' : smsResult.reason === 'error' ? 'error' : 'not_sent';
  record.smsError = smsResult.sent || smsResult.reason !== 'error' ? '' : String(smsResult.message || '').slice(0, 200);
  await reservations.put(record);

  res.status(201).json({
    reservation: publicView(record),
    emailSent: emailResult.sent,
    smsSent: smsResult.sent,
  });
});

// ---- Guest ticket access (no account needed) ----
// A ticket is only ever shown for a matching email + ticket code. There is no link-only access.
// Find a ticket with the email used + the ticket code.
router.post('/lookup', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (limited('lookup:' + req.ip, 20, 10 * 60 * 1000) || limited('lookup-email:' + email, 8, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });
  }
  const code = String((req.body || {}).code || '').trim().toUpperCase().replace(/\s+/g, '');
  const all = await reservations.all();
  const r = all.find((x) => x.email === email && ticketCode(x) === code);
  if (!r) return res.status(404).json({ error: 'No ticket matches that email and code.' });
  res.json({ reservation: publicView(r) });
});

// Lost the email? Send the upcoming tickets for this address again.
router.post('/resend', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (limited('resend:' + req.ip, 5, 60 * 60 * 1000) || limited('resend:' + email, 3, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  const all = await reservations.all();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const mine = all.filter((x) => x.email === email && x.status === 'confirmed' && x.date >= today).slice(0, 5);
  for (const r of mine) {
    if (!r.ticketToken) {
      r.ticketToken = newToken();
      await reservations.put(r);
    }
  }
  for (const r of mine) await sendBookingConfirmation(r, appUrl(req)).catch(() => null);
  // Same answer whether or not tickets exist, so emails can't be probed.
  res.json({ ok: true });
});

// The QR holds the whole ticket (name, contact, movie, seats). Only the ticket holder (email + code) or staff can get it.
router.post('/qr', async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (limited('qr:' + req.ip, 60, 10 * 60 * 1000)) return res.status(429).end();
  const r = (await reservations.all()).find((x) => ticketCode(x) === code && (req.isAdmin || x.email === email));
  if (!r) return res.status(404).end();
  const png = await QRCode.toBuffer(qrText(r, appUrl(req)), { margin: 1, width: 440, errorCorrectionLevel: 'L' });
  res.set('Content-Type', 'image/png').set('Cache-Control', 'private, no-store').send(png);
});

// Staff scan a ticket's QR code: full details + whether it is still valid.
router.get('/verify', requireAdmin, async (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  const r = (await reservations.all()).find((x) => ticketCode(x) === code);
  if (!r) return res.status(404).json({ error: 'No ticket found for that code.' });
  res.json({ reservation: publicView(r) });
});

router.get('/', requireAdmin, async (_req, res) => {
  res.json({ reservations: await reservations.all() });
});

router.patch('/:id/cancel', requireAdmin, async (req, res) => {
  const all = await reservations.all();
  const r = all.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  if (r.status !== 'cancelled') {
    r.status = 'cancelled';
    await applyLocks(r);
    await reservations.put(r);
    await sendReservationUpdate(r, 'cancelled', appUrl(req)).catch(() => null);
    await notifyWaitlist(r.movieId, r.date, r.time, appUrl(req));
  }
  res.json({ reservation: r });
});

router.put('/:id', requireAdmin, async (req, res) => {
  const all = await reservations.all();
  const idx = all.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Reservation not found' });

  const b = req.body || {};
  const current = all[idx];
  const next = {
    ...current,
    name: b.name !== undefined ? String(b.name).trim() || current.name : current.name,
    email: b.email !== undefined ? String(b.email).trim().toLowerCase() : current.email,
    phone: b.phone !== undefined && String(b.phone).trim() !== '' ? cleanPhone(b.phone) : current.phone,
    status: b.status === 'cancelled' ? 'cancelled' : b.status === 'confirmed' ? 'confirmed' : current.status,
    movieId: b.movieId !== undefined ? b.movieId : current.movieId,
    movieTitle: b.movieTitle !== undefined ? b.movieTitle : current.movieTitle,
    date: b.date !== undefined ? b.date : current.date,
    time: b.time !== undefined ? b.time : current.time,
    hall: b.hall !== undefined ? b.hall : current.hall,
    seats: Array.isArray(b.seats) ? b.seats : current.seats,
  };

  if (!EMAIL_RE.test(next.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (b.phone !== undefined && String(b.phone).trim() !== '' && !next.phone) return res.status(400).json({ error: 'Enter a valid phone number.' });

  if (next.status === 'confirmed') {
    if (!next.seats.length) return res.status(400).json({ error: 'Select at least one seat, or set status to Cancelled.' });
    if (!next.seats.every((s) => ALL_SEATS.includes(s))) return res.status(400).json({ error: 'Invalid seat code.' });
    const taken = takenSeats(all, next.movieId, next.date, next.time, next.id);
    const conflict = next.seats.some((s) => taken.includes(s));
    if (conflict) return res.status(409).json({ error: 'One of those seats is already taken for that showtime.', taken });
  }

  try {
    await applyLocks(next);
  } catch (e) {
    if (e.conflict) return res.status(409).json({ error: 'One of those seats is already taken for that showtime.' });
    throw e;
  }
  if (!next.ticketToken) next.ticketToken = newToken();
  if (!next.movieDuration) next.movieDuration = current.movieDuration || 120;
  await reservations.put(next);

  // Tell the guest when something that affects their ticket changed.
  const moved = ['movieId', 'date', 'time', 'hall'].some((k) => next[k] !== current[k]) ||
    next.seats.join() !== current.seats.join();
  if (next.status === 'cancelled' && current.status !== 'cancelled') {
    await sendReservationUpdate(next, 'cancelled', appUrl(req)).catch(() => null);
  } else if (next.status === 'confirmed' && (moved || current.status !== 'confirmed')) {
    await sendReservationUpdate(next, 'changed', appUrl(req)).catch(() => null);
  }
  if (current.status === 'confirmed' && (next.status !== 'confirmed' || moved)) {
    await notifyWaitlist(current.movieId, current.date, current.time, appUrl(req));
  }
  res.json({ reservation: next });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const r = (await reservations.all()).find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  await pool.query('DELETE FROM seat_locks WHERE rid = $1', [r.id]);
  await reservations.remove(r.id);
  if (r.status === 'confirmed') await notifyWaitlist(r.movieId, r.date, r.time, appUrl(req));
  res.json({ ok: true });
});

router.post('/:id/resend-email', requireAdmin, async (req, res) => {
  const all = await reservations.all();
  const r = all.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  if (!r.ticketToken) r.ticketToken = newToken();
  const [result, sms] = await Promise.all([
    sendBookingConfirmation(r, appUrl(req)),
    sendBookingSms(r, ticketCode(r)).catch((e) => ({ sent: false, reason: 'error', message: e.message })),
  ]);
  r.emailStatus = result.sent ? 'sent' : result.reason === 'error' ? 'error' : 'not_sent';
  r.smsStatus = sms.sent ? 'sent' : sms.reason === 'error' ? 'error' : 'not_sent';
  r.smsError = sms.sent || sms.reason !== 'error' ? '' : String(sms.message || '').slice(0, 200);
  await reservations.put(r);
  res.json({ emailSent: result.sent, smsSent: sms.sent, reservation: r });
});

// ---- Door check-in (staff) ----
router.post('/:id/checkin', requireAdmin, async (req, res) => {
  const all = await reservations.all();
  const r = all.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  if (r.status !== 'confirmed') return res.status(400).json({ error: 'That reservation is cancelled.' });
  if (req.body && req.body.undo) delete r.checkedInAt;
  else if (!r.checkedInAt) r.checkedInAt = new Date().toISOString();
  await reservations.put(r);
  res.json({ reservation: publicView(r), full: r });
});

// ---- Waitlist ----
router.post('/waitlist', async (req, res) => {
  if (limited('wl:' + req.ip, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  const b = req.body || {};
  if (b.website) return res.status(400).json({ error: 'Could not join the waitlist.' });
  const name = String(b.name || '').trim().slice(0, 80);
  const email = String(b.email || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const movie = (await moviesTable.all()).find((m) => m.id === b.movieId);
  const st = movie && movie.showtimes.find((x) => x.date === b.date && x.time === b.time);
  if (!st) return res.status(404).json({ error: 'That showtime no longer exists.' });
  if (hasStarted(b.date, b.time)) return res.status(400).json({ error: 'This showing has already started.' });
  const taken = takenSeats(await reservations.all(), movie.id, b.date, b.time).length;
  if (taken < capacityOf(st) && !st.closed) return res.status(400).json({ error: 'Seats are still available. You can reserve them now.' });
  const list = await waitlist.all();
  if (!list.some((w) => w.email === email && w.movieId === movie.id && w.date === b.date && w.time === b.time && !w.notifiedAt)) {
    await waitlist.put({ id: genId('w'), name, email, movieId: movie.id, movieTitle: movie.title, date: b.date, time: b.time, createdAt: new Date().toISOString() });
  }
  res.json({ ok: true });
});
router.get('/waitlist', requireAdmin, async (_req, res) => {
  res.json({ waitlist: await waitlist.all() });
});
router.delete('/waitlist/:id', requireAdmin, async (req, res) => {
  await waitlist.remove(req.params.id);
  res.json({ ok: true });
});

// ---- Data cleanup ----
// Deletes reservation records whose showing ended more than `days` days ago (privacy retention).
async function purgeOld(days) {
  const cutoff = manilaDate(-days);
  const old = (await reservations.all()).filter((r) => r.date < cutoff);
  for (const r of old) {
    await pool.query('DELETE FROM seat_locks WHERE rid = $1', [r.id]);
    await reservations.remove(r.id);
  }
  const wl = (await waitlist.all()).filter((w) => w.date < cutoff);
  for (const w of wl) await waitlist.remove(w.id);
  return old.length;
}
router.post('/cleanup', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.action === 'old_reservations') {
    const days = Math.max(0, parseInt(b.days, 10) || 0);
    return res.json({ deleted: await purgeOld(days) });
  }
  if (b.action === 'past_showtimes') {
    const today = manilaDate(0);
    const all = await moviesTable.all();
    let removed = 0;
    for (const m of all) {
      const keep = (m.showtimes || []).filter((st) => st.date >= today);
      removed += (m.showtimes || []).length - keep.length;
      m.showtimes = keep;
    }
    await moviesTable.save(all);
    return res.json({ deleted: removed });
  }
  if (b.action === 'all_reservations') {
    if (b.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
    const all = await reservations.all();
    await pool.query('DELETE FROM seat_locks');
    for (const r of all) await reservations.remove(r.id);
    for (const w of await waitlist.all()) await waitlist.remove(w.id);
    return res.json({ deleted: all.length });
  }
  res.status(400).json({ error: 'Unknown cleanup action.' });
});

// ---- Reminders: the day before a showing ----
// Vercel Cron calls this daily (with CRON_SECRET). Staff can also run it from the panel.
router.get('/reminders', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const bearerOk = secret && req.get('authorization') === `Bearer ${secret}`;
  if (!req.isAdmin && !bearerOk) return res.status(401).json({ error: 'Not allowed.' });
  const target = manilaDate(1);
  const due = (await reservations.all()).filter((r) => r.status === 'confirmed' && r.date === target && !r.reminderSentAt);
  let sent = 0;
  for (const r of due) {
    const out = await sendReminder(r, appUrl(req)).catch(() => ({ sent: false }));
    if (out && out.sent) { r.reminderSentAt = new Date().toISOString(); await reservations.put(r); sent++; }
  }
  let purged = 0;
  try {
    const row = await readSiteRow();
    const days = row.retentionDays === undefined ? 180 : parseInt(row.retentionDays, 10);
    if (days > 0) purged = await purgeOld(days);
  } catch (e) { console.warn('[retention]', e.message); }
  res.json({ date: target, due: due.length, sent, purged });
});

module.exports = router;
module.exports.backfillSeatLocks = backfillSeatLocks;