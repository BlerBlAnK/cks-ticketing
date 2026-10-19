const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');

// Connect over WebSocket (port 443) instead of raw Postgres (port 5432).
neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 25000,
});

const TABLES = ['movies', 'reservations', 'users', 'settings', 'waitlist'];

async function initSchema() {
  for (const t of TABLES) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${t} (
        id   TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);
  }
  // One row per booked seat. The primary key makes it impossible for two guests to hold the same seat.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seat_locks (
      k   TEXT PRIMARY KEY,
      rid TEXT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS seat_locks_rid ON seat_locks (rid);`);
  // Trailer videos uploaded from the admin's computer (stored in pieces).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id         TEXT PRIMARY KEY,
      mime       TEXT NOT NULL,
      size       BIGINT NOT NULL,
      chunk_size INT NOT NULL,
      complete   BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_chunks (
      id   TEXT NOT NULL,
      idx  INT NOT NULL,
      data BYTEA NOT NULL,
      PRIMARY KEY (id, idx)
    );
  `);
}

function makeTable(key, seedFn) {
  return {
    async all() {
      const { rows } = await pool.query(`SELECT data FROM ${key} ORDER BY id`);
      return rows.map((r) => r.data);
    },
    // Row-level helpers: change one record without touching (or deleting) the others.
    async put(item) {
      await pool.query(
        `INSERT INTO ${key} (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [item.id, JSON.stringify(item)]
      );
      return item;
    },
    async remove(id) {
      const r = await pool.query(`DELETE FROM ${key} WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },
    async save(list) {
      // Few round trips (Neon is remote): drop removed rows, then upsert everything in one statement.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM ${key} WHERE id <> ALL($1::text[])`, [list.map((i) => i.id)]);
        if (list.length) {
          await client.query(
            `INSERT INTO ${key} (id, data)
             SELECT x.id, x.data FROM jsonb_to_recordset($1::jsonb) AS x(id text, data jsonb)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
            [JSON.stringify(list.map((i) => ({ id: i.id, data: i })))]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      } finally {
        client.release();
      }
      return list;
    },
    async seedIfEmpty() {
      if (!seedFn) return;
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${key}`);
      if (rows[0].n === 0) await this.save(seedFn());
    },
  };
}

module.exports = { pool, initSchema, makeTable };