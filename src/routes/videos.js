const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAdmin } = require('../auth');

// Trailer videos uploaded from the admin's own computer.
// Vercel limits each request to ~4.5 MB, so the browser sends the file in 3 MB pieces,
// they are stored in Postgres, and the video is streamed back with Range requests.
const router = express.Router();

const CHUNK = 3 * 1024 * 1024;
const MAX_BYTES = 60 * 1024 * 1024;
const MIMES = ['video/mp4', 'video/webm'];

function newId() {
  return 'v_' + crypto.randomBytes(8).toString('hex');
}
const ID_RE = /^v_[a-f0-9]{16}$/;

async function deleteVideo(id) {
  if (!ID_RE.test(id)) return;
  await pool.query('DELETE FROM video_chunks WHERE id = $1', [id]);
  await pool.query('DELETE FROM videos WHERE id = $1', [id]);
}

// "/api/videos/v_xxx" -> delete it (used when a trailer is replaced or a movie is removed).
async function deleteVideoByUrl(url) {
  const m = /^\/api\/videos\/(v_[a-f0-9]{16})$/.exec(String(url || ''));
  if (m) await deleteVideo(m[1]);
}

// Housekeeping: drop unfinished uploads, and finished ones no movie uses any more.
async function cleanup() {
  await pool.query(
    `DELETE FROM video_chunks WHERE id IN (SELECT id FROM videos WHERE complete = false AND created_at < now() - interval '1 hour')`
  );
  await pool.query(`DELETE FROM videos WHERE complete = false AND created_at < now() - interval '1 hour'`);
  const { rows } = await pool.query(
    `SELECT id FROM videos WHERE complete = true AND created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM movies WHERE movies.data->>'trailer' = '/api/videos/' || videos.id)`
  );
  for (const r of rows) await deleteVideo(r.id);
}

router.post('/start', requireAdmin, async (req, res) => {
  const mime = String((req.body || {}).mime || '');
  const size = Number((req.body || {}).size);
  if (!MIMES.includes(mime)) return res.status(400).json({ error: 'Use an MP4 or WebM video.' });
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'Empty file.' });
  if (size > MAX_BYTES) {
    return res.status(400).json({ error: `That video is too large. The limit is ${Math.round(MAX_BYTES / 1048576)} MB.` });
  }
  await cleanup().catch(() => null);
  const id = newId();
  await pool.query('INSERT INTO videos (id, mime, size, chunk_size, complete) VALUES ($1,$2,$3,$4,false)', [id, mime, size, CHUNK]);
  res.json({ id, chunkSize: CHUNK });
});

router.put('/:id/chunk', requireAdmin, express.raw({ type: '*/*', limit: '4mb' }), async (req, res) => {
  const id = req.params.id;
  const i = Number(req.query.i);
  if (!ID_RE.test(id) || !Number.isInteger(i) || i < 0) return res.status(400).json({ error: 'Bad chunk.' });
  const { rows } = await pool.query('SELECT size, complete FROM videos WHERE id = $1', [id]);
  if (!rows[0] || rows[0].complete) return res.status(404).json({ error: 'Upload not found.' });
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length || body.length > CHUNK) return res.status(400).json({ error: 'Bad chunk size.' });
  if (i * CHUNK >= Number(rows[0].size)) return res.status(400).json({ error: 'Chunk out of range.' });
  await pool.query(
    'INSERT INTO video_chunks (id, idx, data) VALUES ($1,$2,$3) ON CONFLICT (id, idx) DO UPDATE SET data = EXCLUDED.data',
    [id, i, body]
  );
  res.json({ ok: true });
});

router.post('/:id/finish', requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad id.' });
  const { rows } = await pool.query('SELECT size, chunk_size FROM videos WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Upload not found.' });
  const size = Number(rows[0].size);
  const expected = Math.ceil(size / CHUNK);
  const got = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(length(data)),0)::bigint AS bytes FROM video_chunks WHERE id = $1', [id]);
  if (got.rows[0].n !== expected || Number(got.rows[0].bytes) !== size) {
    return res.status(400).json({ error: 'The upload is incomplete. Please try again.' });
  }
  await pool.query('UPDATE videos SET complete = true WHERE id = $1', [id]);
  res.json({ ok: true, url: `/api/videos/${id}` });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  await deleteVideo(req.params.id);
  res.json({ ok: true });
});

// Public: stream the video. Each response is at most one chunk (3 MB) so it fits Vercel's response limit.
router.get('/:id', async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(404).end();
  const { rows } = await pool.query('SELECT mime, size, chunk_size, complete FROM videos WHERE id = $1', [id]);
  const v = rows[0];
  if (!v || !v.complete) return res.status(404).end();
  const size = Number(v.size);
  const ch = Number(v.chunk_size);

  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    if (range[1] === '' && range[2] !== '') {
      start = Math.max(0, size - Number(range[2]));
    } else {
      start = Number(range[1] || 0);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start >= size || start > end) {
      res.set('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
  }
  end = Math.min(end, start + ch - 1, size - 1);

  const first = Math.floor(start / ch);
  const last = Math.floor(end / ch);
  const data = await pool.query('SELECT idx, data FROM video_chunks WHERE id = $1 AND idx BETWEEN $2 AND $3 ORDER BY idx', [id, first, last]);
  const buf = Buffer.concat(data.rows.map((r) => r.data));
  const slice = buf.subarray(start - first * ch, end - first * ch + 1);

  res.status(206).set({
    'Content-Type': v.mime,
    'Content-Length': String(slice.length),
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(slice);
});

module.exports = { router, deleteVideoByUrl };