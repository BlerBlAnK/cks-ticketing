// Staff-only login. There is no public sign-up: the only account is the one
// defined by ADMIN_EMAIL + ADMIN_PASSWORD in the environment settings.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { setUserCookie, clearUserCookie } = require('../auth');
const { sendSignInAlert } = require('../email');

const router = express.Router();

// Failed-login counter kept in the database, so it holds even when the server restarts or runs on several instances.
const { pool } = require('../db');
const WINDOW = 10 * 60 * 1000;
async function failState(key) {
  const { rows } = await pool.query(`SELECT data FROM settings WHERE id = $1`, [key]);
  const d = rows[0] && rows[0].data;
  return d && d.reset > Date.now() ? d : { n: 0, reset: Date.now() + WINDOW };
}
async function blocked(ip) {
  try {
    return (await failState('lf:' + ip)).n >= 8 || (await failState('lf:all')).n >= 40;
  } catch (e) { return false; }
}
async function recordFail(ip) {
  try {
    for (const key of ['lf:' + ip, 'lf:all']) {
      const st = await failState(key);
      st.n += 1;
      await pool.query(`INSERT INTO settings (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [key, JSON.stringify(st)]);
    }
  } catch (e) { /* ignore */ }
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) {
    crypto.timingSafeEqual(A, A);
    return false;
  }
  return crypto.timingSafeEqual(A, B);
}

async function passwordOk(input) {
  const stored = process.env.ADMIN_PASSWORD || '';
  if (!stored) return false;
  if (stored.startsWith('$2')) return bcrypt.compare(input, stored); // a bcrypt hash also works
  return safeEqual(input, stored);
}

router.post('/login', async (req, res) => {
  const ip = req.ip;
  if (await blocked(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Staff login is not set up on this server yet. Set ADMIN_EMAIL and ADMIN_PASSWORD.' });
  }
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    return res.status(503).json({ error: 'JWT_SECRET is not set on this server.' });
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const passOk = await passwordOk(password);
  if (email !== adminEmail || !passOk) {
    await recordFail(ip);
    await new Promise((r) => setTimeout(r, 700)); // slows down password guessing
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  const user = { id: 'admin', name: 'Admin', email: adminEmail };
  setUserCookie(res, user);
  try { await sendSignInAlert(user, { ip }); } catch (e) { /* ignore */ }
  res.json({ user });
});

router.post('/logout', (_req, res) => {
  clearUserCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

module.exports = router;