const db = require('./db');

// Gateway-wide settings kept in PostgreSQL so they can be changed while running.
const DEFAULTS = Object.freeze({
  // Longest ident a station may use, in seconds.
  ident_max_seconds: 5,
  // Upload space for an account that has no quota of its own, in megabytes.
  default_storage_quota_mb: 500,
});

let cache = null;
let cachedAt = 0;

async function all() {
  if (!cache || Date.now() - cachedAt > 5000) {
    const { rows } = await db.query('SELECT key, value FROM settings');
    cache = { ...DEFAULTS, ...Object.fromEntries(rows.map((row) => [row.key, row.value])) };
    cachedAt = Date.now();
  }
  return cache;
}

const get = async (key) => (await all())[key];

// A null value removes the setting, returning it to its default.
async function set(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) await db.query('DELETE FROM settings WHERE key = $1', [key]);
    else {
      await db.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()',
        [key, JSON.stringify(value)]
      );
    }
  }
  cache = null;
}

module.exports = { all, get, set, DEFAULTS };
