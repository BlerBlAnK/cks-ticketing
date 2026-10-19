require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { initSchema } = require('./src/db');
const { attachUser, attachAdmin } = require('./src/auth');
const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const { router: movieRoutes, movies, migratePosters } = require('./src/routes/movies');
const reservationRoutes = require('./src/routes/reservations');
const { router: videoRoutes } = require('./src/routes/videos');
const contactRoutes = require('./src/routes/contact');
const { isConfigured: emailConfigured, verifyEmail } = require('./src/email');
const { wrapRouter } = require('./src/asyncSafe');

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err && err.message ? err.message : err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err && err.message ? err.message : err));

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true); // so links use the right host/protocol behind Vercel

// Security headers. The site may be embedded only on the origins listed here (default: the CKS website).
const EMBED = (process.env.EMBED_ORIGINS || 'https://kapampangancenter.org https://www.kapampangancenter.org').trim();
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Content-Security-Policy': `frame-ancestors 'self' ${EMBED}`,
  });
  if (req.secure || req.get('x-forwarded-proto') === 'https') res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(express.json({ limit: '4mb' })); // Vercel allows ~4.5MB request bodies; poster uploads arrive as base64

// Add the ARI and ARIA films once (a settings flag stops them coming back if the admin deletes them).
async function addFeaturedOnce() {
  const { pool } = require('./src/db');
  const { rows } = await pool.query(`SELECT 1 FROM settings WHERE id = 'seed_ari_aria'`);
  if (rows.length) return;
  const all = await movies.all();
  for (const f of require('./src/seed').featuredMovies()) {
    if (!all.some((m) => m.id === f.id || String(m.title).trim().toUpperCase() === f.title)) all.push(f);
  }
  await movies.save(all);
  await pool.query(`INSERT INTO settings (id, data) VALUES ('seed_ari_aria', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
}

// Make sure the tables exist and sample movies are seeded -- once per server start.
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await initSchema();
      await movies.seedIfEmpty();
      await addFeaturedOnce();
      await reservationRoutes.backfillSeatLocks();
      await migratePosters();
    })().catch((err) => {
      readyPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return readyPromise;
}
app.use('/api', async (_req, res, next) => {
  try {
    await ensureReady();
    next();
  } catch (err) {
    console.error('Database not ready:', err.message);
    res.status(503).json({ error: 'The database is not reachable right now. Please try again in a moment.' });
  }
});

app.use(cookieParser());
app.use(attachUser);
app.use(attachAdmin);

// ---- API ----
app.use('/api/auth', wrapRouter(authRoutes));
app.use('/api/admin', wrapRouter(adminRoutes));
app.use('/api/movies', wrapRouter(movieRoutes));
app.use('/api/reservations', wrapRouter(reservationRoutes));
app.use('/api/contact', wrapRouter(contactRoutes));
app.use('/api/videos', wrapRouter(videoRoutes));
app.use('/api/site', wrapRouter(require('./src/routes/site')));
app.use('/api/stats', wrapRouter(require('./src/routes/stats')));

app.get('/api/health', async (req, res) => {
  const out = { ok: true, emailConfigured: emailConfigured() };
  // Point an uptime monitor at /api/health: it answers 503 when the database is unreachable.
  try { await require('./src/db').pool.query('SELECT 1'); out.db = true; }
  catch (e) { out.ok = false; out.db = false; return res.status(503).json(out); }
  // /api/health?email=1 checks that Gmail actually accepts the login.
  if (req.query.email) out.emailLogin = await verifyEmail();
  res.json(out);
});

// ---- static frontend (used when running locally; on Vercel the /public folder is served by its CDN) ----
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- error handler ----
app.use((err, _req, res, _next) => {
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error(err);
  const msg = String((err && err.message) || '');
  const db = /connect|timeout|terminated|ECONN|ENOTFOUND/i.test(msg);
  const text =
    status === 413 ? 'That upload is too large.' :
    status < 500 ? 'The request could not be read.' :
    db ? 'The database did not respond. Please try again.' : 'Something went wrong on the server.';
  res.status(status).json({ error: text });
});

module.exports = app;

// Local development: `npm start` -> http://localhost:3000
if (require.main === module) {
  ensureReady()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`CKS Ticketing running at http://localhost:${PORT}`);
        console.log(`Email delivery: ${emailConfigured() ? 'CONFIGURED (real emails will send)' : 'not configured (emails will be logged, not sent)'}`);
        verifyEmail().then((r) => {
          if (r.ok) console.log('Email login: OK. Tickets will be emailed.');
          else if (r.reason === 'error') console.error('Email login FAILED. Tickets will NOT be emailed:', r.message, '\n  Fix SMTP_USER / SMTP_PASS (use a Gmail App Password, 16 letters, no spaces).');
        });
      });
    })
    .catch((err) => {
      console.error('Failed to start server:', err.message || err);
      console.error('Check that DATABASE_URL in .env is a valid, reachable Postgres connection string.');
      process.exit(1);
    });
}