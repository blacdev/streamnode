const config = require('./config');
const db = require('./db');
const { redis } = require('./cache');

// Accumulators written by the engine (see rust_src/src/stats.rs).
const ACCUMULATORS = ['stats:bytes', 'stats:sessions', 'stats:listener_ms'];
const LOCK_KEY = 'lock:stats-flush';

// Atomically moves the live accumulators aside, so the engine keeps counting
// into fresh keys while this snapshot is written to PostgreSQL.
const SNAPSHOT_SCRIPT = `
local moved = 0
local keys = redis.call('KEYS', 'stats:peak:*')
for _, key in ipairs(KEYS) do keys[#keys + 1] = key end
for _, key in ipairs(keys) do
  if redis.call('EXISTS', key) == 1 then
    redis.call('RENAME', key, 'flush:' .. ARGV[1] .. ':' .. key)
    moved = moved + 1
  end
end
return moved`;

const PERSIST_SQL = `
WITH input AS (
  SELECT s.id AS station_id, v.bytes, v.peak, v.listener_seconds, v.sessions
  FROM unnest($2::text[], $3::bigint[], $4::int[], $5::bigint[], $6::int[])
       AS v(slug, bytes, peak, listener_seconds, sessions)
  JOIN stations s ON s.slug = v.slug
), inserted AS (
  INSERT INTO station_stats_minute (station_id, recorded_at, bytes, peak_listeners, listener_seconds, sessions)
  SELECT station_id, $1::timestamptz, bytes, peak, listener_seconds, sessions FROM input
  ON CONFLICT (station_id, recorded_at) DO NOTHING
  RETURNING station_id, recorded_at, bytes, peak_listeners, listener_seconds, sessions
)
INSERT INTO station_stats_daily AS d (station_id, day, bytes, peak_listeners, listener_seconds, sessions)
SELECT station_id, (recorded_at AT TIME ZONE 'UTC')::date, bytes, peak_listeners, listener_seconds, sessions
FROM inserted
ON CONFLICT (station_id, day) DO UPDATE SET
  bytes = d.bytes + EXCLUDED.bytes,
  peak_listeners = GREATEST(d.peak_listeners, EXCLUDED.peak_listeners),
  listener_seconds = d.listener_seconds + EXCLUDED.listener_seconds,
  sessions = d.sessions + EXCLUDED.sessions`;

async function persistSnapshot(stamp) {
  const prefix = `flush:${stamp}:`;
  const peakKeys = [];
  for await (const key of redis.scanIterator({ MATCH: `${prefix}stats:peak:*`, COUNT: 200 })) peakKeys.push(key);
  const [bytes, sessions, listenerMs, ...peaks] = await Promise.all([
    redis.hGetAll(`${prefix}stats:bytes`),
    redis.hGetAll(`${prefix}stats:sessions`),
    redis.hGetAll(`${prefix}stats:listener_ms`),
    ...peakKeys.map((key) => redis.zRangeWithScores(key, 0, -1)),
  ]);
  // Each engine reports its own peak; a station spread over several engines
  // peaks at (at most) their sum.
  const peak = {};
  for (const entry of peaks.flat()) peak[entry.value] = (peak[entry.value] || 0) + entry.score;
  const slugs = [...new Set([...Object.keys(bytes), ...Object.keys(sessions), ...Object.keys(listenerMs), ...Object.keys(peak)])];

  if (slugs.length) {
    const num = (source, slug) => Math.round(Number(source[slug]) || 0);
    // The row timestamp is the snapshot time, which makes a retry after a
    // crash idempotent: the same snapshot can never be counted twice.
    await db.query(PERSIST_SQL, [
      new Date(Number(stamp)).toISOString(),
      slugs,
      slugs.map((s) => num(bytes, s)),
      slugs.map((s) => num(peak, s)),
      slugs.map((s) => Math.round(num(listenerMs, s) / 1000)),
      slugs.map((s) => num(sessions, s)),
    ]);
  }
  await redis.del([...ACCUMULATORS.map((key) => prefix + key), ...peakKeys]);
  return slugs.length;
}

// Moves Redis counters into PostgreSQL. Snapshots left behind by an earlier
// failed run are picked up first, so a database outage delays data rather
// than losing it.
async function flush() {
  const locked = await redis.set(LOCK_KEY, String(process.pid), { NX: true, EX: 50 });
  if (!locked) return;
  try {
    await redis.eval(SNAPSHOT_SCRIPT, { keys: ACCUMULATORS, arguments: [String(Date.now())] });
    const stamps = new Set();
    for await (const key of redis.scanIterator({ MATCH: 'flush:*', COUNT: 200 })) {
      stamps.add(key.split(':')[1]);
    }
    for (const stamp of [...stamps].sort()) await persistSnapshot(stamp);
  } finally {
    await redis.del(LOCK_KEY).catch(() => {});
  }
}

async function prune() {
  await db.query("DELETE FROM station_stats_minute WHERE recorded_at < now() - make_interval(days => $1)", [config.minuteRetentionDays]);
  await db.query("DELETE FROM audit_log WHERE at < now() - make_interval(days => $1)", [config.auditRetentionDays]);
}

const BUCKET_SECONDS = { minute: 60, hour: 3600, day: 86400 };

function chooseInterval(from, to) {
  const hours = (to - from) / 3600000;
  if (hours <= 6) return 'minute';
  if (hours <= 24 * 14) return 'hour';
  return 'day';
}

function point(row, interval) {
  return {
    t: row.t instanceof Date ? row.t.toISOString() : `${row.t}T00:00:00.000Z`,
    bytes: row.bytes,
    peak_listeners: row.peak_listeners,
    avg_listeners: Math.round((row.listener_seconds / BUCKET_SECONDS[interval]) * 100) / 100,
    listener_hours: Math.round((row.listener_seconds / 3600) * 100) / 100,
    sessions: row.sessions,
  };
}

// Time series for one station. Buckets without activity are omitted.
async function series(stationId, from, to, interval) {
  let result;
  if (interval === 'day') {
    result = await db.query(
      `SELECT day AS t, bytes, peak_listeners, listener_seconds, sessions
       FROM station_stats_daily WHERE station_id = $1 AND day >= $2::timestamptz::date AND day <= $3::timestamptz::date
       ORDER BY day`,
      [stationId, from.toISOString(), to.toISOString()]
    );
  } else {
    result = await db.query(
      `SELECT date_trunc('${interval}', recorded_at) AS t,
              SUM(bytes)::bigint AS bytes, MAX(peak_listeners) AS peak_listeners,
              SUM(listener_seconds)::bigint AS listener_seconds, SUM(sessions)::bigint AS sessions
       FROM station_stats_minute WHERE station_id = $1 AND recorded_at >= $2 AND recorded_at < $3
       GROUP BY 1 ORDER BY 1`,
      [stationId, from.toISOString(), to.toISOString()]
    );
  }
  return result.rows.map((row) => point(row, interval));
}

// Per-station totals over a range of UTC days (inclusive); the billing view.
async function usage({ from, to, userId, stationId }) {
  const { rows } = await db.query(
    `SELECT s.id, s.slug, s.name, s.user_id, s.external_id,
            COALESCE(SUM(d.bytes), 0)::bigint AS bytes,
            COALESCE(MAX(d.peak_listeners), 0) AS peak_listeners,
            COALESCE(SUM(d.listener_seconds), 0)::bigint AS listener_seconds,
            COALESCE(SUM(d.sessions), 0)::bigint AS sessions
     FROM stations s
     LEFT JOIN station_stats_daily d ON d.station_id = s.id AND d.day >= $1::date AND d.day <= $2::date
     WHERE ($3::int IS NULL OR s.user_id = $3) AND ($4::int IS NULL OR s.id = $4)
     GROUP BY s.id ORDER BY s.slug`,
    [from, to, userId ?? null, stationId ?? null]
  );
  return rows.map((row) => ({
    station: row.slug,
    name: row.name,
    user_id: row.user_id,
    external_id: row.external_id,
    bytes: row.bytes,
    gigabytes: Math.round((row.bytes / 1e9) * 1000) / 1000,
    peak_listeners: row.peak_listeners,
    listener_hours: Math.round((row.listener_seconds / 3600) * 100) / 100,
    sessions: row.sessions,
  }));
}

// Bytes counted by the engine that have not reached PostgreSQL yet.
async function pendingBytes() {
  const pending = await redis.hGetAll('stats:bytes');
  return Object.fromEntries(Object.entries(pending).map(([slug, v]) => [slug, Number(v) || 0]));
}

module.exports = { flush, prune, series, usage, pendingBytes, chooseInterval, BUCKET_SECONDS };
