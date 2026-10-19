const express = require('express');
const { requireAdmin } = require('../auth');
const crypto = require('crypto');
const { pool } = require('../db');
const { clean, readRow, writeRow, getSite, publicView, DEFAULT_GALLERY } = require('../site');

const router = express.Router();

router.get('/', async (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ site: await getSite() });
});

router.put('/', requireAdmin, async (req, res) => {
  const row = await readRow();
  if (req.body && req.body.reset) {
    const { logoData, logoAt, gallery } = row;
    await writeRow({ ...(logoData ? { logoData, logoAt } : {}), ...(gallery ? { gallery } : {}) });
  } else {
    let c;
    try { c = clean(req.body || {}); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    await writeRow({ ...row, ...c });
  }
  res.json({ site: publicView(await readRow()) });
});

const LOGO_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

router.post('/logo', requireAdmin, async (req, res) => {
  const m = LOGO_RE.exec(String((req.body && req.body.dataUrl) || ''));
  if (!m) return res.status(400).json({ error: 'Use a PNG, JPG or WebP image.' });
  if (m[2].length > 2.5 * 1024 * 1024) return res.status(400).json({ error: 'That logo is too large. Use one under 1 MB.' });
  const row = await readRow();
  await writeRow({ ...row, logoData: `data:${m[1]};base64,${m[2]}`, logoAt: Date.now() });
  res.json({ site: publicView(await readRow()) });
});

router.delete('/logo', requireAdmin, async (_req, res) => {
  const { logoData, logoAt, ...rest } = await readRow();
  await writeRow(rest);
  res.json({ site: publicView(rest) });
});

router.get('/logo', async (_req, res) => {
  const row = await readRow();
  const m = row.logoData && LOGO_RE.exec(row.logoData);
  if (!m) return res.redirect(302, '/logo.png');
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(m[2], 'base64'));
});

// ---- Theater photos (About page) ----
const MAX_PHOTOS = 24;
async function saveImgRow(id, dataUrl) {
  await pool.query(
    `INSERT INTO settings (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    ['gimg_' + id, JSON.stringify({ dataUrl })]
  );
}

router.post('/gallery', requireAdmin, async (req, res) => {
  const m = LOGO_RE.exec(String((req.body && req.body.dataUrl) || ''));
  if (!m) return res.status(400).json({ error: 'Use a PNG, JPG or WebP photo.' });
  if (m[2].length > 3.2 * 1024 * 1024) return res.status(400).json({ error: 'That photo is too large. Try one under 2 MB.' });
  const row = await readRow();
  const list = Array.isArray(row.gallery) ? row.gallery : DEFAULT_GALLERY.map((x) => ({ ...x }));
  if (list.length >= MAX_PHOTOS) return res.status(400).json({ error: `You can show up to ${MAX_PHOTOS} photos.` });
  const id = 'g' + crypto.randomBytes(6).toString('hex');
  await saveImgRow(id, `data:${m[1]};base64,${m[2]}`);
  list.push({ id, url: `/api/site/gallery/${id}`, caption: String((req.body.caption || '')).trim().slice(0, 120) });
  await writeRow({ ...row, gallery: list });
  res.json({ site: publicView(await readRow()) });
});

router.put('/gallery/:id', requireAdmin, async (req, res) => {
  const row = await readRow();
  const list = Array.isArray(row.gallery) ? row.gallery : DEFAULT_GALLERY.map((x) => ({ ...x }));
  const item = list.find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Photo not found.' });
  item.caption = String((req.body || {}).caption || '').trim().slice(0, 120);
  await writeRow({ ...row, gallery: list });
  res.json({ site: publicView(await readRow()) });
});

router.delete('/gallery/:id', requireAdmin, async (req, res) => {
  const row = await readRow();
  const list = Array.isArray(row.gallery) ? row.gallery : DEFAULT_GALLERY.map((x) => ({ ...x }));
  const next = list.filter((x) => x.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: 'Photo not found.' });
  await writeRow({ ...row, gallery: next });
  if (/^g[0-9a-f]{12}$/.test(req.params.id)) await pool.query(`DELETE FROM settings WHERE id = $1`, ['gimg_' + req.params.id]);
  res.json({ site: publicView(await readRow()) });
});

router.get('/gallery/:id', async (req, res) => {
  if (!/^g[0-9a-f]{12}$/.test(req.params.id)) return res.status(404).end();
  const { rows } = await pool.query(`SELECT data FROM settings WHERE id = $1`, ['gimg_' + req.params.id]);
  const m = rows[0] && LOGO_RE.exec(rows[0].data.dataUrl);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]).set('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(m[2], 'base64'));
});

module.exports = router;