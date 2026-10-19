const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../auth');
const { manilaDate } = require('../time');

const router = express.Router();
const hits = new Map();

// Counts one page visit per browser session (no personal data kept).
router.post('/visit', async (req, res) => {
  if (req.isAdmin) return res.json({ ok: true });
  const now = Date.now();
  const arr = (hits.get(req.ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  arr.push(now); hits.set(req.ip, arr);
  if (arr.length > 20) return res.json({ ok: true });
  const day = manilaDate(0);
  await pool.query(
    `INSERT INTO settings (id, data) VALUES ('stats', jsonb_build_object('days', jsonb_build_object($1::text, 1)))
     ON CONFLICT (id) DO UPDATE SET data = jsonb_set(
       settings.data, ARRAY['days', $1::text],
       to_jsonb(COALESCE((settings.data->'days'->>$1::text)::int, 0) + 1), true)`,
    [day]
  );
  res.json({ ok: true });
});

router.get('/', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(`SELECT data FROM settings WHERE id = 'stats'`);
  const days = (rows[0] && rows[0].data && rows[0].data.days) || {};
  const out = [];
  for (let i = 13; i >= 0; i--) { const d = manilaDate(-i); out.push({ date: d, visits: days[d] || 0 }); }
  res.json({ days: out });
});

module.exports = router;