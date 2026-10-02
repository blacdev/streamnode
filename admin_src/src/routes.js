const express = require('express');
const db = require('./db');
const { redis } = require('./cache');
const auth = require('./auth');
const security = require('./security');
const stations = require('./stations');
const stats = require('./stats');
const haproxy = require('./haproxy');
const capacity = require('./capacity');
const cluster = require('./cluster');
const updates = require('./updates');
const config = require('./config');
const v = require('./validate');
const { wrap, badRequest, invalid, forbidden, notFound, conflict, HttpError } = require('./errors');

const router = express.Router();
const isAdmin = (req) => req.user.role === 'admin';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

function audit(req, action, target, detail) {
  db.query('INSERT INTO audit_log (user_id, username, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5, $6)', [
    req.user ? req.user.id : null,
    req.user ? req.user.username : null,
    action,
    target,
    detail ? JSON.stringify(detail) : null,
    req.ip,
  ]).catch((err) => console.error('[audit]', err.message));
}

// Tenants only ever see their own stations; a miss and a foreign station
// look the same so slugs cannot be probed.
async function loadStation(req) {
  const row = await stations.findBySlug(req.params.slug);
  if (!row || (!isAdmin(req) && row.user_id !== req.user.id)) throw notFound('Station');
  return row;
}

async function presentOne(req, row) {
  const live = await stations.liveFor([row.slug]);
  return stations.present(row, live.get(row.slug), req);
}

function assignments(fields, startAt = 1) {
  const keys = Object.keys(fields);
  return {
    sql: keys.map((key, i) => `${key} = $${i + startAt}`).join(', '),
    values: keys.map((key) => fields[key]),
  };
}

function translateStationError(err) {
  if (err.code === UNIQUE_VIOLATION) return conflict('slug_taken', 'A station with this slug already exists.');
  if (err.code === FK_VIOLATION) return invalid([{ field: 'user_id', message: 'does not match an existing user' }]);
  return err;
}

// ── Public ────────────────────────────────────────────────────────────────

router.get('/health', wrap(async (req, res) => {
  const checks = await Promise.allSettled([db.query('SELECT 1'), redis.ping()]);
  const body = {
    status: checks.every((c) => c.status === 'fulfilled') ? 'ok' : 'degraded',
    database: checks[0].status === 'fulfilled' ? 'ok' : 'unavailable',
    cache: checks[1].status === 'fulfilled' ? 'ok' : 'unavailable',
  };
  res.status(body.status === 'ok' ? 200 : 503).json(body);
}));

// Open to any origin so a station's own web player can show what is on air.
router.get('/public/stations/:slug/now-playing', wrap(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=5');
  const row = await stations.findBySlug(req.params.slug);
  if (!row || !row.is_active) throw notFound('Station');
  const live = (await stations.liveFor([row.slug])).get(row.slug);
  const stream = `${stations.baseUrl(req)}/${row.slug}`;
  res.json({
    station: row.slug,
    name: row.name,
    online: live.online,
    title: live.title,
    artist: live.artist,
    artwork: live.artwork || row.artwork_url,
    stream_url: stream,
    playlist_urls: { m3u: `${stream}.m3u`, pls: `${stream}.pls` },
  });
}));

router.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw badRequest('username and password are required.');
  }
  res.json(await auth.login(req, username, password));
}));

// A slave node enrolling itself. Authenticated by the one-time join token in the body.
router.post('/cluster/join', wrap(async (req, res) => {
  res.json(await cluster.join(req.body || {}, req.ip));
}));

// ── Everything below requires authentication ──────────────────────────────

router.use(auth.authenticate);

router.post('/auth/logout', wrap(async (req, res) => {
  await auth.logout(req);
  res.status(204).end();
}));

router.get('/auth/me', (req, res) => {
  const { id, username, role, external_id, max_stations } = req.user;
  res.json({ id, username, role, external_id, max_stations, authenticated_via: req.user.via });
});

// ── Stations ──────────────────────────────────────────────────────────────

router.get('/stations', wrap(async (req, res) => {
  const limit = v.intParam(req.query.limit, { name: 'limit', min: 1, max: 500, fallback: 100 });
  const offset = v.intParam(req.query.offset, { name: 'offset', min: 0, max: 10000000, fallback: 0 });
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace(/\?/g, `$${params.length}`));
  };
  if (!isAdmin(req)) add('user_id = ?', req.user.id);
  else if (req.query.user_id !== undefined) add('user_id = ?', v.intParam(req.query.user_id, { name: 'user_id', min: 1, max: 2147483647 }));
  if (req.query.external_id) add('external_id = ?', String(req.query.external_id));
  if (req.query.q) add('(slug ILIKE ? OR name ILIKE ?)', `%${String(req.query.q).replace(/[%_\\]/g, '\\$&')}%`);
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [list, count] = await Promise.all([
    db.query(`SELECT ${stations.COLUMNS} FROM stations ${filter} ORDER BY slug LIMIT ${limit} OFFSET ${offset}`, params),
    db.query(`SELECT COUNT(*)::int AS total FROM stations ${filter}`, params),
  ]);
  const live = await stations.liveFor(list.rows.map((row) => row.slug));
  res.json({
    total: count.rows[0].total,
    limit,
    offset,
    stations: list.rows.map((row) => stations.present(row, live.get(row.slug), req)),
  });
}));

async function createStation(req, fields) {
  if (!isAdmin(req)) {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM stations WHERE user_id = $1', [req.user.id]);
    if (rows[0].n >= req.user.max_stations) {
      throw forbidden(
        req.user.max_stations === 0
          ? 'Stations on this account are provisioned by the administrator.'
          : `This account has reached its limit of ${req.user.max_stations} station(s). Ask the administrator to raise it.`
      );
    }
  }
  const row = { user_id: req.user.id, ...fields };
  const keys = Object.keys(row);
  try {
    const { rows } = await db.query(
      `INSERT INTO stations (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${stations.COLUMNS}`,
      keys.map((key) => row[key])
    );
    await stations.publish(rows[0]);
    audit(req, 'station.create', rows[0].slug, fields);
    return rows[0];
  } catch (err) {
    throw translateStationError(err);
  }
}

async function updateStation(req, current, fields) {
  if (!Object.keys(fields).length) return current;
  const set = assignments(fields);
  try {
    const { rows } = await db.query(
      `UPDATE stations SET ${set.sql}, updated_at = now() WHERE id = $${set.values.length + 1} RETURNING ${stations.COLUMNS}`,
      [...set.values, current.id]
    );
    if (rows[0].slug !== current.slug) await stations.unpublish(current.slug);
    await stations.publish(rows[0]);
    audit(req, 'station.update', rows[0].slug, fields);
    return rows[0];
  } catch (err) {
    throw translateStationError(err);
  }
}

router.post('/stations', wrap(async (req, res) => {
  const fields = v.parseStation(req.body, { isAdmin: isAdmin(req) });
  const row = await createStation(req, fields);
  res.status(201).json(await presentOne(req, row));
}));

router.get('/stations/:slug', wrap(async (req, res) => {
  res.json(await presentOne(req, await loadStation(req)));
}));

// Idempotent provisioning: creates the station, or updates the supplied
// fields if it already exists. Fields left out keep their current values.
router.put('/stations/:slug', wrap(async (req, res) => {
  const slug = req.params.slug;
  if (req.body && req.body.slug !== undefined && req.body.slug !== slug) {
    throw badRequest('The slug in the body does not match the URL. Use PATCH to rename a station.');
  }
  const existing = await stations.findBySlug(slug);
  if (existing && !isAdmin(req) && existing.user_id !== req.user.id) {
    throw conflict('slug_taken', 'A station with this slug already exists.');
  }
  if (existing) {
    const fields = v.parseStation(req.body, { partial: true, isAdmin: isAdmin(req), allowSlug: false });
    return res.json(await presentOne(req, await updateStation(req, existing, fields)));
  }
  const fields = v.parseStation({ ...req.body, slug }, { isAdmin: isAdmin(req) });
  res.status(201).json(await presentOne(req, await createStation(req, fields)));
}));

router.patch('/stations/:slug', wrap(async (req, res) => {
  const current = await loadStation(req);
  const fields = v.parseStation(req.body, { partial: true, isAdmin: isAdmin(req), allowSlug: isAdmin(req) });
  if (!isAdmin(req) && req.body && req.body.slug !== undefined) {
    throw invalid([{ field: 'slug', message: 'can only be changed by an administrator' }]);
  }
  res.json(await presentOne(req, await updateStation(req, current, fields)));
}));

// Owners may delete their own stations; loadStation enforces the ownership.
router.delete('/stations/:slug', wrap(async (req, res) => {
  const current = await loadStation(req);
  await db.query('DELETE FROM stations WHERE id = $1', [current.id]);
  await stations.unpublish(current.slug);
  audit(req, 'station.delete', current.slug);
  res.status(204).end();
}));

for (const [action, active] of [['suspend', false], ['unsuspend', true]]) {
  router.post(`/stations/:slug/${action}`, auth.requireAdmin, wrap(async (req, res) => {
    const current = await loadStation(req);
    const { rows } = await db.query(
      `UPDATE stations SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING ${stations.COLUMNS}`,
      [active, current.id]
    );
    await stations.publish(rows[0]);
    audit(req, `station.${action}`, current.slug);
    res.json(await presentOne(req, rows[0]));
  }));
}

router.get('/stations/:slug/status', wrap(async (req, res) => {
  const row = await loadStation(req);
  const live = (await stations.liveFor([row.slug])).get(row.slug);
  res.json({ station: row.slug, is_active: row.is_active, max_listeners: row.max_listeners, ...live });
}));

router.get('/stations/:slug/stats', wrap(async (req, res) => {
  const row = await loadStation(req);
  const to = v.timeParam(req.query.to, 'to', new Date());
  const from = v.timeParam(req.query.from, 'from', new Date(to.getTime() - 24 * 3600 * 1000));
  if (from >= to) throw invalid([{ field: 'from', message: 'must be earlier than "to"' }]);
  const interval = req.query.interval || stats.chooseInterval(from, to);
  if (!stats.BUCKET_SECONDS[interval]) throw invalid([{ field: 'interval', message: 'must be minute, hour or day' }]);
  const buckets = (to - from) / 1000 / stats.BUCKET_SECONDS[interval];
  if (buckets > 5000) throw invalid([{ field: 'interval', message: 'range is too long for this interval; use a coarser one' }]);

  const points = await stats.series(row.id, from, to, interval);
  const totals = points.reduce(
    (sum, p) => ({
      bytes: sum.bytes + p.bytes,
      peak_listeners: Math.max(sum.peak_listeners, p.peak_listeners),
      listener_hours: sum.listener_hours + p.listener_hours,
      sessions: sum.sessions + p.sessions,
    }),
    { bytes: 0, peak_listeners: 0, listener_hours: 0, sessions: 0 }
  );
  totals.listener_hours = Math.round(totals.listener_hours * 100) / 100;
  res.json({ station: row.slug, from: from.toISOString(), to: to.toISOString(), interval, totals, points });
}));

function usageRange(req) {
  const today = new Date().toISOString().slice(0, 10);
  const to = v.dateParam(req.query.to, 'to', today);
  const from = v.dateParam(req.query.from, 'from', `${today.slice(0, 8)}01`);
  if (from > to) throw invalid([{ field: 'from', message: 'must not be later than "to"' }]);
  return { from, to };
}

router.get('/stations/:slug/usage', wrap(async (req, res) => {
  const row = await loadStation(req);
  const range = usageRange(req);
  const [usage] = await stats.usage({ ...range, stationId: row.id });
  res.json({ ...range, ...usage });
}));

// ── Account-wide usage and live metrics ───────────────────────────────────

router.get('/usage', wrap(async (req, res) => {
  const range = usageRange(req);
  let userId = req.user.id;
  if (isAdmin(req)) {
    userId = req.query.user_id === undefined ? null : v.intParam(req.query.user_id, { name: 'user_id', min: 1, max: 2147483647 });
  }
  const rows = await stats.usage({ ...range, userId });
  const totals = rows.reduce(
    (sum, r) => ({ bytes: sum.bytes + r.bytes, listener_hours: sum.listener_hours + r.listener_hours, sessions: sum.sessions + r.sessions }),
    { bytes: 0, listener_hours: 0, sessions: 0 }
  );
  totals.gigabytes = Math.round((totals.bytes / 1e9) * 1000) / 1000;
  totals.listener_hours = Math.round(totals.listener_hours * 100) / 100;
  res.json({ ...range, totals, stations: rows });
}));

router.get('/metrics', wrap(async (req, res) => {
  const scope = isAdmin(req) ? null : req.user.id;
  const [{ rows }, pending] = await Promise.all([
    db.query(
      `SELECT s.slug, COALESCE(SUM(d.bytes), 0)::bigint AS bytes
       FROM stations s LEFT JOIN station_stats_daily d ON d.station_id = s.id
       WHERE ($1::int IS NULL OR s.user_id = $1) GROUP BY s.id ORDER BY s.slug`,
      [scope]
    ),
    stats.pendingBytes(),
  ]);
  const live = await stations.liveFor(rows.map((row) => row.slug));
  res.json(rows.map((row) => {
    const now = live.get(row.slug);
    return {
      station: row.slug,
      total_bytes: row.bytes + (pending[row.slug] || 0),
      listeners: now.listeners,
      online: now.online,
      source: now.source,
    };
  }));
}));

router.get('/overview', wrap(async (req, res) => {
  const scope = isAdmin(req) ? null : req.user.id;
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await db.query(
    `SELECT s.slug, s.is_active,
            COALESCE(SUM(d.bytes) FILTER (WHERE d.day = $2::date), 0)::bigint AS bytes_today,
            COALESCE(SUM(d.bytes), 0)::bigint AS bytes_month
     FROM stations s
     LEFT JOIN station_stats_daily d ON d.station_id = s.id AND d.day >= date_trunc('month', $2::date)::date
     WHERE ($1::int IS NULL OR s.user_id = $1) GROUP BY s.id`,
    [scope, today]
  );
  const live = await stations.liveFor(rows.map((row) => row.slug));
  const onAir = [...live.values()].filter((l) => l.online);
  res.json({
    stations: rows.length,
    suspended_stations: rows.filter((row) => !row.is_active).length,
    stations_on_air: onAir.length,
    listeners_now: onAir.reduce((sum, l) => sum + l.listeners, 0),
    bytes_today: rows.reduce((sum, row) => sum + row.bytes_today, 0),
    bytes_this_month: rows.reduce((sum, row) => sum + row.bytes_month, 0),
  });
}));

// ── API keys ──────────────────────────────────────────────────────────────

router.get('/api-keys', wrap(async (req, res) => {
  let userId = req.user.id;
  if (isAdmin(req) && req.query.user_id !== undefined) {
    userId = req.query.user_id === 'all' ? null : v.intParam(req.query.user_id, { name: 'user_id', min: 1, max: 2147483647 });
  }
  const { rows } = await db.query(
    `SELECT k.id, k.user_id, u.username, k.name, k.key_prefix, k.last_used_at, k.created_at
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE ($1::int IS NULL OR k.user_id = $1) ORDER BY k.created_at DESC`,
    [userId]
  );
  res.json({ api_keys: rows });
}));

router.post('/api-keys', wrap(async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 50) throw invalid([{ field: 'name', message: 'must be 1-50 characters' }]);
  let userId = req.user.id;
  if (body.user_id !== undefined && body.user_id !== req.user.id) {
    if (!isAdmin(req)) throw forbidden('Only administrators can create keys for other accounts.');
    if (!Number.isInteger(body.user_id)) throw invalid([{ field: 'user_id', message: 'must be a user id' }]);
    userId = body.user_id;
  }
  const key = security.generateApiKey();
  try {
    const { rows } = await db.query(
      'INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id, user_id, name, key_prefix, created_at',
      [userId, name, security.keyPrefix(key), security.sha256(key)]
    );
    audit(req, 'api_key.create', `key:${rows[0].id}`, { user_id: userId, name });
    // The only time the full key is ever returned.
    res.status(201).json({ ...rows[0], key });
  } catch (err) {
    if (err.code === FK_VIOLATION) throw invalid([{ field: 'user_id', message: 'does not match an existing user' }]);
    throw err;
  }
}));

router.delete('/api-keys/:id', wrap(async (req, res) => {
  const id = v.intParam(req.params.id, { name: 'id', min: 1, max: 2147483647 });
  const { rowCount } = await db.query('DELETE FROM api_keys WHERE id = $1 AND ($2::int IS NULL OR user_id = $2)', [
    id,
    isAdmin(req) ? null : req.user.id,
  ]);
  if (!rowCount) throw notFound('API key');
  audit(req, 'api_key.revoke', `key:${id}`);
  res.status(204).end();
}));

// ── Users (administrators only) ───────────────────────────────────────────

const USER_COLUMNS = 'id, username, role, external_id, max_stations, is_active, created_at, updated_at';
const users = express.Router();
users.use(auth.requireAdmin);

users.get('/', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}, (SELECT COUNT(*)::int FROM stations s WHERE s.user_id = users.id) AS station_count
     FROM users WHERE ($1::text IS NULL OR external_id = $1) ORDER BY username`,
    [req.query.external_id ? String(req.query.external_id) : null]
  );
  res.json({ users: rows });
}));

async function saveUser(req, res, existingId) {
  const fields = v.parseUser(req.body, { partial: Boolean(existingId) });
  if (fields.password) {
    fields.password_hash = await security.hashPassword(fields.password);
    delete fields.password;
  }
  try {
    if (existingId) {
      delete fields.username;
      if (existingId === req.user.id && (fields.is_active === false || fields.role === 'tenant')) {
        throw conflict('self_lockout', 'You cannot disable or demote the account you are signed in with.');
      }
      if (!Object.keys(fields).length) throw badRequest('No changes supplied.');
      const set = assignments(fields);
      const { rows } = await db.query(
        `UPDATE users SET ${set.sql}, updated_at = now() WHERE id = $${set.values.length + 1} RETURNING ${USER_COLUMNS}`,
        [...set.values, existingId]
      );
      if (!rows[0]) throw notFound('User');
      audit(req, 'user.update', rows[0].username, { ...fields, password_hash: undefined });
      return res.json(rows[0]);
    }
    // Tenants can run several stations from one account unless told otherwise.
    if (fields.max_stations === undefined && fields.role !== 'admin') fields.max_stations = config.defaultMaxStations;
    const keys = Object.keys(fields);
    const { rows } = await db.query(
      `INSERT INTO users (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${USER_COLUMNS}`,
      keys.map((key) => fields[key])
    );
    audit(req, 'user.create', rows[0].username);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw conflict('user_exists', 'That username or external_id is already in use.');
    throw err;
  }
}

const userId = (req) => v.intParam(req.params.id, { name: 'id', min: 1, max: 2147483647 });

users.post('/', wrap((req, res) => saveUser(req, res, null)));
users.patch('/:id', wrap((req, res) => saveUser(req, res, userId(req))));

users.get('/:id', wrap(async (req, res) => {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId(req)]);
  if (!rows[0]) throw notFound('User');
  res.json(rows[0]);
}));

users.delete('/:id', wrap(async (req, res) => {
  const id = userId(req);
  if (id === req.user.id) throw conflict('self_lockout', 'You cannot delete the account you are signed in with.');
  const owned = await db.query('SELECT slug FROM stations WHERE user_id = $1', [id]);
  const { rows } = await db.query('DELETE FROM users WHERE id = $1 RETURNING username', [id]);
  if (!rows[0]) throw notFound('User');
  await Promise.all(owned.rows.map((row) => stations.unpublish(row.slug)));
  audit(req, 'user.delete', rows[0].username, { stations_removed: owned.rows.map((row) => row.slug) });
  res.status(204).end();
}));

router.use('/users', users);

// ── Streaming servers (administrators only) ───────────────────────────────

const nodes = express.Router();
nodes.use(auth.requireAdmin);

const presentNodes = (rows) => capacity.describe(rows);

// Applies the change to HAProxy straight away; the periodic sync retries on failure.
async function applyNodes() {
  if (!haproxy.enabled()) return false;
  try {
    await haproxy.sync();
    return true;
  } catch {
    return false;
  }
}

function translateNodeError(err) {
  if (err.code === UNIQUE_VIOLATION) return conflict('server_exists', 'A server with this name or address already exists.');
  return err;
}

nodes.get('/', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM engine_nodes ORDER BY is_builtin DESC, name');
  res.json({ managed: haproxy.enabled(), servers: await presentNodes(rows) });
}));

nodes.post('/', wrap(async (req, res) => {
  // With a setup key, the master finishes the setup of a slave that is waiting for it.
  if (req.body && req.body.setup_key !== undefined) {
    const { host, port = 3000, setup_key: setupKey } = req.body;
    const fields = v.parseNode({ name: 'pending', host, port });
    if (typeof setupKey !== 'string' || setupKey.length < 16) throw invalid([{ field: 'setup_key', message: 'is the key printed by the slave installer' }]);
    const row = await cluster.enrolWaitingServer({
      address: fields.host, port: fields.port || 3000, setupKey, masterUrl: stations.baseUrl(req), userId: req.user.id,
    });
    if (!row) throw new (require('./errors').HttpError)(502, 'setup_incomplete', 'The server accepted the setup but has not registered yet. Check its log.');
    audit(req, 'server.setup', row.name, { host: row.host, port: row.port });
    return res.status(201).json({ ...(await presentNodes([row]))[0], applied: true });
  }
  const fields = v.parseNode(req.body);
  const keys = Object.keys(fields);
  try {
    const { rows } = await db.query(
      `INSERT INTO engine_nodes (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((key) => fields[key])
    );
    audit(req, 'server.add', rows[0].name, fields);
    const applied = await applyNodes();
    res.status(201).json({ ...(await presentNodes(rows))[0], applied });
  } catch (err) {
    throw translateNodeError(err);
  }
}));

const nodeId = (req) => v.intParam(req.params.id, { name: 'id', min: 1, max: 2147483647 });

nodes.patch('/:id', wrap(async (req, res) => {
  const found = await db.query('SELECT * FROM engine_nodes WHERE id = $1', [nodeId(req)]);
  if (!found.rows[0]) throw notFound('Server');
  const fields = v.parseNode(req.body, { partial: true, builtin: found.rows[0].is_builtin });
  if (!Object.keys(fields).length) throw badRequest('No changes supplied.');
  const set = assignments(fields);
  try {
    const { rows } = await db.query(
      `UPDATE engine_nodes SET ${set.sql}, updated_at = now() WHERE id = $${set.values.length + 1} RETURNING *`,
      [...set.values, found.rows[0].id]
    );
    audit(req, 'server.update', rows[0].name, fields);
    const applied = await applyNodes();
    res.json({ ...(await presentNodes(rows))[0], applied });
  } catch (err) {
    throw translateNodeError(err);
  }
}));

// Takes a server out of rotation as having no audio, or hands the decision
// back to the engine's own detection. Its listeners are released so their
// players reconnect to the other servers.
nodes.put('/:id/audio-status', wrap(async (req, res) => {
  const body = req.body || {};
  if (body.status !== 'no_audio' && body.status !== 'auto') throw invalid([{ field: 'status', message: 'must be "no_audio" or "auto"' }]);
  let reason = null;
  if (body.status === 'no_audio') {
    reason = body.reason === undefined || body.reason === null || body.reason === '' ? 'set by an administrator' : body.reason;
    if (typeof reason !== 'string' || reason.length > 200) throw invalid([{ field: 'reason', message: 'must be at most 200 characters' }]);
    reason = reason.replace(/[\u0000-\u001f]/g, ' ').trim() || 'set by an administrator';
  }
  const { rows } = await db.query('UPDATE engine_nodes SET audio_override = $1, updated_at = now() WHERE id = $2 RETURNING *', [reason, nodeId(req)]);
  if (!rows[0]) throw notFound('Server');
  await cluster.publishOverrides();
  audit(req, reason ? 'server.no_audio' : 'server.audio_auto', rows[0].name, reason ? { reason } : null);
  res.json((await presentNodes(rows))[0]);
}));

nodes.delete('/:id', wrap(async (req, res) => {
  const { rows } = await db.query('DELETE FROM engine_nodes WHERE id = $1 AND NOT is_builtin RETURNING name', [nodeId(req)]);
  db.query("DELETE FROM join_tokens WHERE expires_at < now() - interval '7 days'").catch(() => {});
  if (!rows[0]) throw notFound('Removable server');
  audit(req, 'server.remove', rows[0].name);
  await applyNodes();
  res.status(204).end();
}));

router.use('/servers', nodes);

// Join tokens: what a new slave node presents to enrol.
router.post('/cluster/join-tokens', auth.requireAdmin, wrap(async (req, res) => {
  const body = req.body || {};
  const minutes = body.expires_minutes === undefined ? config.joinTokenMinutes : body.expires_minutes;
  const maxUses = body.max_uses === undefined ? 1 : body.max_uses;
  const errors = [];
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) errors.push({ field: 'expires_minutes', message: 'must be an integer from 1 to 10080' });
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) errors.push({ field: 'max_uses', message: 'must be an integer from 1 to 100' });
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 100)) errors.push({ field: 'note', message: 'must be at most 100 characters' });
  if (errors.length) throw invalid(errors);
  const created = await cluster.createToken({ note: body.note || null, minutes, maxUses, userId: req.user.id });
  audit(req, 'join_token.create', `token:${created.id}`);
  // The only time the token is shown.
  res.status(201).json({ ...created, master_url: stations.baseUrl(req), install_command: cluster.installCommand(stations.baseUrl(req), created.token) });
}));

router.get('/cluster/join-tokens', auth.requireAdmin, wrap(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, token_prefix, note, bound_address, max_uses, uses, expires_at, created_at FROM join_tokens WHERE expires_at > now() AND uses < max_uses ORDER BY id DESC'
  );
  res.json({ join_tokens: rows });
}));

router.delete('/cluster/join-tokens/:id', auth.requireAdmin, wrap(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM join_tokens WHERE id = $1', [v.intParam(req.params.id, { name: 'id', min: 1, max: 2147483647 })]);
  if (!rowCount) throw notFound('Join token');
  audit(req, 'join_token.revoke', `token:${req.params.id}`);
  res.status(204).end();
}));

// Which version is running and whether the repository has a newer one.
router.get('/system/version', auth.requireAdmin, wrap(async (req, res) => {
  if (req.query.refresh !== undefined) await updates.check();
  res.json(updates.status());
}));

// When updates are installed: automatically at a time of day, or only on request.
router.put('/system/update-settings', auth.requireAdmin, wrap(async (req, res) => {
  const saved = updates.saveSettings(req.body || {});
  audit(req, 'updates.settings', null, saved);
  res.json(updates.status());
}));

// Installs the latest version on the host's next scheduler pass (within 5 minutes).
router.post('/system/update', auth.requireAdmin, wrap(async (req, res) => {
  await updates.check();
  const now = updates.status();
  if (now.update_available === false) throw conflict('up_to_date', 'This server is already on the latest version.');
  if (!now.updater.scheduler_running) {
    throw new HttpError(503, 'updater_unavailable', 'The update scheduler is not running on this server, so the update would never start. On the server run: ./scripts/update.sh schedule install');
  }
  updates.requestInstall();
  audit(req, 'updates.install', now.latest ? now.latest.slice(0, 7) : null);
  res.status(202).json(updates.status());
}));

// CPU, memory, disk and traffic per server, with a verdict on whether to add another.
router.get('/capacity', auth.requireAdmin, wrap(async (req, res) => {
  res.json(await capacity.report());
}));

router.get('/audit-log', auth.requireAdmin, wrap(async (req, res) => {
  const limit = v.intParam(req.query.limit, { name: 'limit', min: 1, max: 500, fallback: 100 });
  const { rows } = await db.query('SELECT id, at, username, action, target, detail, ip FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
  res.json({ entries: rows });
}));

router.use((req, res, next) => next(notFound('Endpoint')));

module.exports = router;
