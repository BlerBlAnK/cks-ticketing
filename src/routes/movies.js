const express = require('express');
const { makeTable } = require('../db');
const { defaultMovies } = require('../seed');
const { requireAdmin } = require('../auth');
const { deleteVideoByUrl } = require('./videos');
const { pool } = require('../db');

const router = express.Router();
const movies = makeTable('movies', defaultMovies);

const RATINGS = ['G', 'PG', 'R-13', 'R-16', 'R-18'];
const HALLS = ['Main Hall'];

// Trailer is a link (YouTube, Vimeo, Facebook, Google Drive or a direct video file). Empty means none.
function cleanTrailer(v) {
  const t = String(v || '').trim().slice(0, 500);
  if (!t) return '';
  if (/^\/api\/videos\/v_[a-f0-9]{16}$/.test(t)) return t; // a video uploaded from the admin's computer
  try {
    const u = new URL(t);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch (e) {
    return null;
  }
}
const TRAILER_ERROR = 'The trailer must be a full link starting with https://';

/* ---- poster images: kept as their own cached files instead of inside the movie list ---- */
const POSTER_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
async function storePoster(id, dataUrl) {
  const m = POSTER_RE.exec(String(dataUrl || ''));
  if (!m) return null;
  await pool.query(
    `INSERT INTO settings (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    ['poster_' + id, JSON.stringify({ mime: m[1], b64: m[2] })]
  );
  return `/api/movies/${id}/poster?v=${Date.now()}`;
}
async function resolveImage(id, image) {
  if (typeof image === 'string' && image.startsWith('data:')) {
    const url = await storePoster(id, image);
    if (!url) { const e = new Error('Use a PNG, JPG or WebP poster.'); e.status = 400; throw e; }
    return url;
  }
  return image || '';
}
// Runs once per server start: move any poster that is still stored inside the movie list.
async function migratePosters() {
  const all = await movies.all();
  let changed = false;
  for (const m of all) {
    if (typeof m.image === 'string' && m.image.startsWith('data:')) {
      const url = await storePoster(m.id, m.image);
      m.image = url || '';
      changed = true;
    }
  }
  if (changed) await movies.save(all);
}

function genId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

router.get('/', async (_req, res) => {
  res.json({ movies: await movies.all() });
});

router.get('/:id/poster', async (req, res) => {
  const { rows } = await pool.query(`SELECT data FROM settings WHERE id = $1`, ['poster_' + req.params.id]);
  if (!rows[0]) return res.status(404).end();
  res.set('Content-Type', rows[0].data.mime).set('Cache-Control', 'public, max-age=31536000, immutable')
    .send(Buffer.from(rows[0].data.b64, 'base64'));
});

router.get('/:id', async (req, res) => {
  const all = await movies.all();
  const m = all.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Movie not found' });
  res.json({ movie: m });
});

router.post('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Title is required' });

  const trailer = cleanTrailer(b.trailer);
  if (trailer === null) return res.status(400).json({ error: TRAILER_ERROR });

  const newId = genId('m');
  let image;
  try { image = await resolveImage(newId, b.image); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const movie = {
    id: newId,
    title: String(b.title).trim(),
    genre: String(b.genre || 'Uncategorized').trim(),
    rating: RATINGS.includes(b.rating) ? b.rating : 'PG',
    duration: Number(b.duration) || 0,
    status: b.status === 'soon' ? 'soon' : 'showing',
    image,
    grad: Number.isInteger(b.grad) ? b.grad : Math.floor(Math.random() * 6),
    synopsis: String(b.synopsis || ''),
    trailer,
    release: b.release || null,
    showtimes: Array.isArray(b.showtimes)
      ? sortSt(b.showtimes.map((st) => normalizeShowtime(st)))
      : [],
  };

  const all = await movies.all();
  all.push(movie);
  await movies.save(all);
  res.status(201).json({ movie });
});

router.put('/:id', requireAdmin, async (req, res) => {
  const all = await movies.all();
  const idx = all.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Movie not found' });

  const b = req.body || {};
  const current = all[idx];
  let trailer = current.trailer || '';
  if (b.trailer !== undefined) {
    trailer = cleanTrailer(b.trailer);
    if (trailer === null) return res.status(400).json({ error: TRAILER_ERROR });
  }
  let image = current.image;
  if (b.image !== undefined) {
    try { image = await resolveImage(current.id, b.image); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  }
  const updated = {
    ...current,
    title: b.title !== undefined ? String(b.title).trim() : current.title,
    genre: b.genre !== undefined ? String(b.genre).trim() : current.genre,
    rating: RATINGS.includes(b.rating) ? b.rating : current.rating,
    duration: b.duration !== undefined ? Number(b.duration) || 0 : current.duration,
    status: b.status === 'soon' || b.status === 'showing' ? b.status : current.status,
    image,
    synopsis: b.synopsis !== undefined ? String(b.synopsis) : current.synopsis,
    trailer,
    release: b.release !== undefined ? b.release : current.release,
    showtimes: Array.isArray(b.showtimes) ? sortSt(b.showtimes.map((st) => normalizeShowtime(st))) : current.showtimes,
  };

  if (!updated.title) return res.status(400).json({ error: 'Title is required' });

  all[idx] = updated;
  await movies.save(all);
  if (current.trailer && current.trailer !== updated.trailer) await deleteVideoByUrl(current.trailer).catch(() => null);
  res.json({ movie: updated });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const all = await movies.all();
  const removed = all.find((x) => x.id === req.params.id);
  const next = all.filter((x) => x.id !== req.params.id);
  if (next.length === all.length) return res.status(404).json({ error: 'Movie not found' });
  await movies.save(next);
  await pool.query(`DELETE FROM settings WHERE id = $1`, ['poster_' + req.params.id]).catch(() => null);
  if (removed && removed.trailer) await deleteVideoByUrl(removed.trailer).catch(() => null);
  res.json({ ok: true });
});

const { tMins } = require('../time');
function sortSt(list) {
  return list.sort((a, b) => String(a.date).localeCompare(String(b.date)) || tMins(a.time) - tMins(b.time));
}

function normalizeShowtime(st) {
  return {
    id: st.id || genId('st'),
    date: st.date,
    time: st.time,
    hall: HALLS.includes(st.hall) ? st.hall : HALLS[0],
    closed: st.closed === true || st.closed === 'true',
    capacity: Math.min(49, Math.max(1, parseInt(st.capacity, 10) || 49)),
  };
}

module.exports = { router, movies, RATINGS, HALLS, migratePosters };