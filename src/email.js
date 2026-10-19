const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { getSite } = require('./site');
const { ticketCode, icsFor, googleCalUrl, ticketUrl, location, qrText } = require('./tickets');

function isConfigured() {
  return !!(process.env.BREVO_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS));
}

// Optional: send through Brevo's web API instead of Gmail (higher daily limits, no Gmail password).
async function sendViaBrevo({ to, subject, html, text, replyTo, attachments }) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || '';
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const sender = m ? { name: m[1].trim() || 'CKS Ticketing', email: m[2].trim() } : { name: 'CKS Ticketing', email: from.trim() };
  const body = {
    sender,
    to: [{ email: to }],
    subject,
    textContent: text,
    // Brevo cannot show inline (cid:) images, so the QR code travels as a normal attachment.
    htmlContent: String(html || '').replace(/<td valign="middle" width="164">[\s\S]*?<img src="cid:ticketqr"[^>]*>[\s\S]*?<\/td>/, ''),
    ...(replyTo ? { replyTo: { email: replyTo } } : {}),
  };
  if (attachments && attachments.length) {
    body.attachment = attachments.map((a) => ({
      name: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content)).toString('base64'),
    }));
  }
  const res = await fetch(process.env.BREVO_URL || 'https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Brevo ${res.status}: ${t.slice(0, 160)}`);
  }
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendMail({ to, subject, html, text, replyTo, attachments }) {
  if (!isConfigured()) {
    console.warn(
      `[email] SMTP is not configured, so no real email was sent.\n` +
        `[email]   Would have sent "${subject}" to ${to}.\n` +
        `[email]   Fill in SMTP_HOST / SMTP_USER / SMTP_PASS to enable real delivery.`
    );
    return { sent: false, reason: 'not_configured' };
  }
  const message = {
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
    ...(replyTo ? { replyTo } : {}),
    ...(attachments ? { attachments } : {}),
  };
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (process.env.BREVO_API_KEY) await sendViaBrevo(message);
      else await getTransporter().sendMail(message);
      return { sent: true };
    } catch (e) {
      lastError = e;
      console.error(`[email] send failed (try ${attempt}):`, e.message);
      if (e.code === 'EAUTH' || /535|Invalid login/i.test(e.message)) break; // wrong password: retrying won't help
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return { sent: false, reason: 'error', message: lastError && lastError.message };
}

// Checks the Gmail login without sending anything.
async function verifyEmail() {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  if (process.env.BREVO_API_KEY) return { ok: true, provider: 'brevo' };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'error', message: e.message };
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function button(href, label, bg, color) {
  return `<a href="${href}" style="display:inline-block;background:${bg};color:${color};padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:14px;margin:4px 6px 4px 0;">${label}</a>`;
}

/* ---------- the ticket email the public receives ---------- */
async function sendBookingConfirmation(reservation, appUrl) {
  const S = await getSite();
  const code = ticketCode(reservation);
  const seats = [...reservation.seats].sort().join(', ');
  const link = appUrl ? ticketUrl(appUrl, reservation) : '';
  const gcal = googleCalUrl(reservation);

  const attachments = [{ filename: `${code}.ics`, content: icsFor(reservation), contentType: 'text/calendar; charset=utf-8' }];
  let hasQr = false;
  try {
    const png = await QRCode.toBuffer(qrText(reservation, appUrl), { width: 400, margin: 1, errorCorrectionLevel: 'L' });
    attachments.push({ filename: 'ticket-qr.png', content: png, cid: 'ticketqr', contentDisposition: 'inline' });
    hasQr = true;
  } catch (e) { /* QR is a bonus; the code works without it */ }

  return sendMail({
    to: reservation.email,
    subject: `Your ticket: ${reservation.movieTitle} on ${fmtDate(reservation.date)}`,
    attachments,
    text:
      `Hi ${reservation.name},\n\n` +
      `Your seats are reserved. This is your ticket.\n\n` +
      `${reservation.movieTitle}\n` +
      `${fmtDate(reservation.date)} at ${reservation.time}\n` +
      `${location()}\n` +
      `Seats: ${seats}\n` +
      `Ticket code: ${code}\n\n` +
      `Show this email (or the code) at the door. It is free, nothing to pay.\n\n` +
      (link ? `Open your ticket page: ${link}\n(For your privacy you will be asked for your email and ticket code.)\n` : '') +
      `To change or cancel, please contact CKS.\n` +
      `Add to Google Calendar: ${gcal}\n\n` +
      `-- ${S.siteTitle}`,
    html: `
      <div style="background:#05070b;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
        <div style="max-width:520px;margin:0 auto;">
          <p style="margin:0 0 14px;color:#b9bdc8;font-size:14px;text-align:center;">Hi ${escapeHtml(reservation.name)}, you're in. Here is your ticket.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:#0d111a;border:2px solid ${S.accent};border-radius:14px;overflow:hidden;">
            <tr><td style="padding:16px 22px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                <td style="color:${S.accent};font-size:12px;font-weight:bold;letter-spacing:3px;">${escapeHtml((S.brandName + ' ' + S.brandSub).toUpperCase())}</td>
                <td align="right"><span style="background:${S.accent};color:#10131b;font-size:12px;font-weight:bold;letter-spacing:3px;padding:4px 10px;border-radius:2px;">ADMIT ${reservation.seats.length > 1 ? reservation.seats.length : 'ONE'}</span></td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:14px 22px 0;">
              <div style="color:#F2EFE9;font-size:30px;font-weight:bold;line-height:1.05;letter-spacing:1px;text-transform:uppercase;">${escapeHtml(reservation.movieTitle)}</div>
              <div style="color:#cfd2da;font-size:13px;margin-top:8px;"><span style="color:#8A8F9C;font-size:10px;letter-spacing:3px;">NAME</span>&nbsp; ${escapeHtml(reservation.name)}</div><div style="color:#cfd2da;font-size:13px;margin-top:3px;"><span style="color:#8A8F9C;font-size:10px;letter-spacing:3px;">PHONE</span>&nbsp; ${escapeHtml(reservation.phone || '—')}</div><div style="color:#cfd2da;font-size:13px;margin-top:3px;"><span style="color:#8A8F9C;font-size:10px;letter-spacing:3px;">EMAIL</span>&nbsp; ${escapeHtml(reservation.email)}</div>
            </td></tr>
            <tr><td style="padding:18px 22px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                <td valign="top"><div style="color:#8A8F9C;font-size:10px;letter-spacing:3px;">DATE</div><div style="color:${S.accent};font-size:22px;font-weight:bold;margin-top:3px;">${escapeHtml(fmtDate(reservation.date))}</div></td>
                <td valign="top" align="right"><div style="color:#8A8F9C;font-size:10px;letter-spacing:3px;">SHOWTIME</div><div style="color:#F2EFE9;font-size:22px;font-weight:bold;margin-top:3px;">${escapeHtml(reservation.time)}</div></td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:16px 22px 0;">
              <div style="color:#8A8F9C;font-size:10px;letter-spacing:3px;margin-bottom:6px;">${reservation.seats.length > 1 ? 'SEATS' : 'SEAT'}</div>
              ${[...reservation.seats].sort().map((x) => `<span style="display:inline-block;border:1px solid ${S.accent};color:${S.accent};background:#171d27;font-size:20px;font-weight:bold;letter-spacing:1px;padding:5px 11px;border-radius:6px;margin:0 6px 6px 0;">${escapeHtml(x)}</span>`).join('')}
            </td></tr>
            <tr><td style="padding:14px 14px 0;"><div style="border-top:2px dashed ${S.accent};opacity:.6;height:0;font-size:0;line-height:0;">&nbsp;</div></td></tr>
            <tr><td style="padding:16px 22px 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                ${hasQr ? `<td valign="middle" width="164"><div style="background:#ffffff;padding:6px;border-radius:8px;width:150px;"><img src="cid:ticketqr" width="150" height="150" alt="Ticket QR code" style="display:block;"></div></td>` : ''}
                <td valign="middle" style="padding-left:${hasQr ? '14' : '0'}px;">
                  <div style="color:#8A8F9C;font-size:10px;letter-spacing:3px;">TICKET CODE</div>
                  <div style="color:${S.accent};font-size:22px;font-family:'Courier New',monospace;font-weight:bold;letter-spacing:2px;margin-top:3px;">${code}</div>
                  <div style="color:#8A8F9C;font-size:11px;margin-top:10px;line-height:1.5;">${escapeHtml(location())}</div>
                </td>
              </tr></table>
            </td></tr>
          </table>
          <p style="color:#b9bdc8;font-size:13px;text-align:center;margin:16px 0 14px;">${escapeHtml(S.emailNote)}</p>
          <div style="text-align:center;">
            ${link ? button(link, 'Open my ticket', '#C1443C', '#ffffff') : ''}
            ${button(gcal, 'Add to Google Calendar', S.accent, '#1a1405')}
          </div>
          <p style="color:#6f7480;font-size:12px;text-align:center;margin:18px 0 0;line-height:1.5;">For your privacy, the ticket page asks for your email and ticket code. A calendar file is attached too. To change or cancel, please contact CKS staff.</p>
        </div>
      </div>`,
  });
}

/* ---------- tell the guest when staff change or cancel their booking ---------- */
async function sendReservationUpdate(reservation, kind, appUrl) {
  const S = await getSite();
  const code = ticketCode(reservation);
  const seats = [...reservation.seats].sort().join(', ');
  const link = appUrl ? ticketUrl(appUrl, reservation) : '';
  if (kind === 'cancelled') {
    return sendMail({
      to: reservation.email,
      subject: `Reservation cancelled: ${reservation.movieTitle}`,
      text:
        `Hi ${reservation.name},\n\nYour reservation ${code} for ${reservation.movieTitle} on ${fmtDate(reservation.date)} at ${reservation.time} has been cancelled.\n` +
        `The seats have been released. You can reserve again any time.\n\n-- ${S.siteTitle}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
          <h2 style="color:#111;">Reservation cancelled</h2>
          <p style="color:#444;">Hi ${escapeHtml(reservation.name)}, your reservation <b>${code}</b> for <b>${escapeHtml(reservation.movieTitle)}</b> on ${escapeHtml(fmtDate(reservation.date))} at ${escapeHtml(reservation.time)} has been cancelled.</p>
          <p style="color:#888;font-size:13px;">The seats were released. You can reserve again any time.</p>
        </div>`,
    });
  }
  return sendMail({
    to: reservation.email,
    subject: `Your reservation was updated: ${reservation.movieTitle}`,
    attachments: [{ filename: `${code}.ics`, content: icsFor(reservation), contentType: 'text/calendar; charset=utf-8' }],
    text:
      `Hi ${reservation.name},\n\nYour reservation was updated. Here are the new details:\n\n` +
      `${reservation.movieTitle}\n${fmtDate(reservation.date)} at ${reservation.time}\nSeats: ${seats}\nTicket code: ${code}\n\n` +
      (link ? `View your ticket: ${link}\n\n` : '') + `-- ${S.siteTitle}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#111;">Your reservation was updated</h2>
        <div style="background:#f6f6f6;border-radius:6px;padding:16px;margin:16px 0;">
          <div style="font-size:18px;font-weight:700;">${escapeHtml(reservation.movieTitle)}</div>
          <div style="color:#555;margin-top:4px;">${escapeHtml(fmtDate(reservation.date))} &middot; ${escapeHtml(reservation.time)}</div>
          <div style="margin-top:10px;">Seats: <strong>${escapeHtml(seats)}</strong></div>
          <div style="margin-top:10px;font-family:monospace;color:#a8862f;">${code}</div>
        </div>
        ${link ? button(link, 'View your ticket', '#C1443C', '#ffffff') : ''}
      </div>`,
  });
}


/* ---------- reminder the day before a showing ---------- */
async function sendReminder(reservation, appUrl) {
  const S = await getSite();
  const code = ticketCode(reservation);
  const seats = [...reservation.seats].sort().join(', ');
  const link = appUrl ? ticketUrl(appUrl, reservation) : '';
  return sendMail({
    to: reservation.email,
    subject: `Reminder: ${reservation.movieTitle} is tomorrow at ${reservation.time}`,
    text:
      `Hi ${reservation.name},\n\nA friendly reminder: ${reservation.movieTitle} is tomorrow, ${fmtDate(reservation.date)} at ${reservation.time}.\n` +
      `Seats: ${seats}\nTicket code: ${code}\n\n` + (link ? `Your ticket: ${link}\n\n` : '') + `Please arrive a little early. -- ${S.siteTitle}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#111;">See you tomorrow</h2>
        <div style="background:#f6f6f6;border-radius:6px;padding:16px;margin:16px 0;">
          <div style="font-size:18px;font-weight:700;">${escapeHtml(reservation.movieTitle)}</div>
          <div style="color:#555;margin-top:4px;">${escapeHtml(fmtDate(reservation.date))} &middot; ${escapeHtml(reservation.time)}</div>
          <div style="margin-top:10px;">Seats: <strong>${escapeHtml(seats)}</strong></div>
          <div style="margin-top:10px;font-family:monospace;color:#a8862f;">${code}</div>
        </div>
        ${link ? button(link, 'Open my ticket', '#C1443C', '#ffffff') : ''}
        <p style="color:#888;font-size:13px;">Please arrive a little early. Need to cancel? Contact CKS staff so someone else can take your seats.</p>
      </div>`,
  });
}

/* ---------- waitlist: seats opened up ---------- */
async function sendWaitlistNotice(entry, appUrl) {
  const S = await getSite();
  return sendMail({
    to: entry.email,
    subject: `Seats opened up: ${entry.movieTitle}`,
    text:
      `Hi ${entry.name},\n\nSeats just opened up for ${entry.movieTitle} on ${fmtDate(entry.date)} at ${entry.time}.\n` +
      `They go quickly, so reserve soon: ${appUrl || ''}\n\n-- ${S.siteTitle}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#111;">Seats opened up</h2>
        <p style="color:#444;">Hi ${escapeHtml(entry.name)}, seats are now available for <b>${escapeHtml(entry.movieTitle)}</b> on ${escapeHtml(fmtDate(entry.date))} at ${escapeHtml(entry.time)}.</p>
        ${appUrl ? button(appUrl, 'Reserve now', '#C1443C', '#ffffff') : ''}
        <p style="color:#888;font-size:13px;">Seats are first come, first served.</p>
      </div>`,
  });
}

/* ---------- heads-up to the staff inbox ---------- */
async function sendAdminNewReservation(reservation, appUrl) {
  const ownerEmail = (process.env.ADMIN_EMAIL || '').trim();
  if (!ownerEmail) return { sent: false, reason: 'no_admin_email' };
  const code = ticketCode(reservation);
  const seats = [...reservation.seats].sort().join(', ');
  return sendMail({
    to: ownerEmail,
    subject: `New reservation: ${reservation.movieTitle} (${seats})`,
    text:
      `New reservation on CKS Ticketing\n\n${reservation.name} <${reservation.email}>\nPhone: ${reservation.phone || 'not given'}\n${reservation.movieTitle}\n` +
      `${fmtDate(reservation.date)} at ${reservation.time}\nSeats: ${seats}\nCode: ${code}\n` +
      (appUrl ? `\nManage it: ${appUrl}\n` : ''),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#111;">New reservation</h2>
        <div style="background:#f6f6f6;border-radius:6px;padding:16px;margin:16px 0;">
          <div style="font-size:18px;font-weight:700;">${escapeHtml(reservation.movieTitle)}</div>
          <div style="color:#555;margin-top:4px;">${escapeHtml(fmtDate(reservation.date))} &middot; ${escapeHtml(reservation.time)}</div>
          <div style="margin-top:10px;">Seats: <strong>${escapeHtml(seats)}</strong></div>
          <div style="margin-top:10px;">${escapeHtml(reservation.name)} &lt;${escapeHtml(reservation.email)}&gt;<br>Phone: ${escapeHtml(reservation.phone || 'not given')}</div>
          <div style="margin-top:10px;font-family:monospace;color:#a8862f;">${code}</div>
        </div>
        ${appUrl ? `<p><a href="${appUrl}" style="color:#C1443C;">Open the website</a></p>` : ''}
      </div>`,
  });
}

async function sendSignInAlert(user, meta) {
  const S = await getSite();
  const when = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' });
  return sendMail({
    to: user.email,
    subject: 'Staff sign-in to CKS Ticketing',
    text: `Someone signed in to the CKS Ticketing admin on ${when}${meta && meta.ip ? ` from IP ${meta.ip}` : ''}.\n\nIf this was you, no action is needed. If it wasn't, change ADMIN_PASSWORD right away.\n\n-- ${S.siteTitle}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#111;">Staff sign-in</h2>
        <p style="color:#444;">Someone signed in to the CKS Ticketing admin on ${escapeHtml(when)}${meta && meta.ip ? ` from IP <code>${escapeHtml(meta.ip)}</code>` : ''}.</p>
        <p style="color:#888;font-size:13px;">If this was you, no action is needed. If it wasn't, change ADMIN_PASSWORD right away.</p>
      </div>`,
  });
}

module.exports = {
  isConfigured,
  verifyEmail,
  sendMail,
  sendBookingConfirmation,
  sendReservationUpdate,
  sendReminder,
  sendWaitlistNotice,
  sendAdminNewReservation,
  sendSignInAlert,
};