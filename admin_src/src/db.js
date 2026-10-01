const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const config = require('./config');

// BIGINT counters comfortably fit a JS number (2^53 bytes is 8 PB).
types.setTypeParser(20, (v) => parseInt(v, 10));
// Keep DATE as 'YYYY-MM-DD' instead of a local-midnight Date.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  options: '-c timezone=UTC',
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const query = (text, params) => pool.query(text, params);

async function waitForDatabase(attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`[db] not ready (${err.message}), retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Applies migrations/*.sql in name order, each exactly once. An advisory lock
// keeps concurrent instances from racing.
async function migrate() {
  await waitForDatabase();
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[db] applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

module.exports = { pool, query, migrate };
