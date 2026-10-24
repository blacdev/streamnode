// The service log: what happened, for Logs in the dashboard.
//
// Streaming servers queue their events in Redis (events:queue); they are moved
// here every couple of seconds. The management service records its own
// directly: administrators' actions, servers coming and going, certificate
// and update runs, and background jobs that fail. Everything is pruned after
// log_retention_days (a setting, at least MIN_DAYS).

const db = require('./db');
const { redis } = require('./cache');
const settings = require('./settings');

const QUEUE = 'events:queue';
const LEVELS = ['info', 'warning', 'error'];
const CATEGORIES = ['switch', 'source', 'station', 'file', 'server', 'certificate', 'update', 'admin', 'system'];
const MIN_DAYS = 7;
const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;
const BATCH = 500;

const clip = (text, max) => (text == null ? null : String(text).slice(0, max));

function row(event) {
  const at = Number(event.at);
  return [
    Number.isFinite(at) && at > 0 ? new Date(at) : new Date(),
    LEVELS.includes(event.level) ? event.level : 'info',
    clip(event.category || 'system', 40),
    clip(event.station || null, 100),
    clip(event.node || null, 100),
    clip(event.message || '', 2000),
  ];
}

async function insert(events) {
  if (!events.length) return;
  const values = [];
  const params = [];
  for (const event of events) {
    const fields = row(event);
    values.push(`(${fields.map((_, i) => `$${params.length + i + 1}`).join(', ')})`);
    params.push(...fields);
  }
  await db.query(`INSERT INTO service_events (at, level, category, station, node, message) VALUES ${values.join(', ')}`, params);
}

// Adds one event of the management service's own. Never throws.
function record(level, category, message, { station = null } = {}) {
  insert([{ at: Date.now(), level, category, station, message }]).catch((err) => console.error('[events]', err.message));
}

// Moves what the streaming servers queued into the database.
async function drain() {
  for (let round = 0; round < 20; round += 1) {
    const raw = await redis.lPopCount(QUEUE, BATCH);
    if (!raw || !raw.length) return;
    const parsed = raw.map((text) => { try { return JSON.parse(text); } catch { return null; } }).filter(Boolean);
    try {
      await insert(parsed);
    } catch (err) {
      // Put them back for the next pass rather than lose them.
      await redis.lPush(QUEUE, raw.reverse()).catch(() => {});
      throw err;
    }
    if (raw.length < BATCH) return;
  }
}

async function retentionDays() {
  const days = Number(await settings.get('log_retention_days'));
  return Number.isInteger(days) ? Math.min(MAX_DAYS, Math.max(MIN_DAYS, days)) : DEFAULT_DAYS;
}

async function prune() {
  await db.query('DELETE FROM service_events WHERE at < now() - make_interval(days => $1)', [await retentionDays()]);
}

// Newest first. `before` is the id of the last event of the previous page.
async function list({ level, category, station, q, from, to, before, limit = 200 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (level === 'warning') add('level = ANY(?)', ['warning', 'error']);
  else if (level === 'error') add('level = ?', 'error');
  if (category) add('category = ?', category);
  if (station) add('station = ?', station);
  if (q) add('message ILIKE ?', `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (from) add('at >= ?', from);
  if (to) add('at <= ?', to);
  if (before) add('id < ?', before);
  params.push(limit);
  const { rows } = await db.query(
    `SELECT id, at, level, category, station, node, message FROM service_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

// ── Things the management service watches for itself ─────────────────────

// Background jobs: a failure is logged when it starts and when it changes, and
// recovery once, rather than once a minute for as long as it lasts.
const jobState = new Map();
function jobResult(name, err) {
  const before = jobState.get(name) || null;
  const now = err ? err.message : null;
  if (now === before) return;
  jobState.set(name, now);
  if (now) record('error', 'system', `Background task "${name}" failed: ${now}`);
  else if (before) record('info', 'system', `Background task "${name}" works again`);
}

module.exports = { record, drain, prune, list, retentionDays, jobResult, LEVELS, CATEGORIES, MIN_DAYS, MAX_DAYS, DEFAULT_DAYS };

// Streaming servers coming and going.
let knownNodes = null;
async function watchNodes(activeNodes) {
  const now = new Set(await activeNodes());
  if (knownNodes) {
    for (const node of now) if (!knownNodes.has(node)) record('info', 'server', `Streaming server "${node}" is online`);
    for (const node of knownNodes) if (!now.has(node)) record('warning', 'server', `Streaming server "${node}" stopped reporting (offline, restarting or unreachable)`);
  }
  knownNodes = now;
}

// What the host's certificate and update scripts last did (files in CONTROL_DIR).
const seenControl = new Map();
function watchControl(readPairs, files) {
  for (const [category, file] of Object.entries(files)) {
    const status = readPairs(file);
    const stamp = status.UPDATED_AT;
    if (!stamp) continue;
    const before = seenControl.get(category);
    seenControl.set(category, stamp);
    // The first look only learns where things stand.
    if (before === undefined || before === stamp || status.STATE === 'running') continue;
    const level = status.STATE === 'failed' ? 'error' : status.STATE === 'waiting' ? 'warning' : 'info';
    record(level, category, status.MESSAGE || `State: ${status.STATE}`);
  }
}

module.exports.watchNodes = watchNodes;
module.exports.watchControl = watchControl;
