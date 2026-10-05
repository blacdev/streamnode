const crypto = require('crypto');
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
const media = require('./media');
const image = require('./image');
const settings = require('./settings');
const dropbox = require('./dropbox');
const streamTypes = require('./streamtypes');
const billing = require('./billing');
const mail = require('./mail');
const notify = require('./notify');
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

// A plan by bandwidth needs to say how much.
function checkPlan(station) {
  if (station.plan_type === 'bandwidth' && !(Number(station.bandwidth_gb) > 0)) {
    throw invalid([{ field: 'bandwidth_gb', message: 'is required for a plan by bandwidth: the data it covers each month, in GB' }]);
  }
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
    // What is on air, and for whatever is missing there, what the station set for itself.
    ...stations.shown(row, live, req),
    stream_url: stream,
    playlist_urls: { m3u: `${stream}.m3u`, pls: `${stream}.pls` },
  });
}));

// A station's uploaded image. Open to anyone and to any site, because it is
// what players and web pages show next to the station.
router.get('/public/stations/:slug/artwork', wrap(async (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  const row = await stations.findBySlug(req.params.slug);
  const file = row && row.is_active && row.artwork_file_id ? await media.find(row.artwork_file_id) : null;
  if (!file || file.kind !== 'image') throw notFound('Station image');
  await media.send(res, file, { open: { versioned: req.query.v === file.sha256.slice(0, 12) } });
}));

// Which kinds of stream can be relayed and what is available on each. Open, so
// that it can be read before an account exists.
router.get('/stream-types', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ stream_types: streamTypes.TYPES });
});

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

// An engine fetching a station's ident or fallback file. Only the audio is
// sent: tags are left out so the file can be spliced straight into a stream.
router.get('/internal/files/:id', wrap(async (req, res) => {
  if (config.engineSecret) {
    const given = Buffer.from(req.get('x-engine-auth') || '');
    const expected = Buffer.from(config.engineSecret);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw forbidden('Only streaming servers may fetch files here.');
  }
  const row = /^\d{1,9}$/.test(req.params.id) ? await media.find(Number(req.params.id)) : null;
  if (!row || row.kind !== 'audio') throw notFound('File');
  await media.send(res, row, { audioOnly: true });
}));

// Where Dropbox sends the administrator's browser back to after the approval.
// The state value, handed out to a signed-in administrator, is what authorises it.
router.get('/storage/dropbox/callback', wrap(async (req, res) => {
  const back = (result, reason) => res.redirect(`/admin/?dropbox=${result}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const redirectUri = /^[a-f0-9]{48}$/.test(state) ? await redis.getDel(`dropbox:state:${state}`) : null;
  if (!redirectUri) return back('error', 'The approval link has expired. Start again from Settings.');
  if (typeof req.query.code !== 'string') return back('error', String(req.query.error_description || req.query.error || 'Dropbox did not approve the connection.'));
  try {
    await dropbox.connect(req.query.code, redirectUri);
  } catch (err) {
    return back('error', err.message);
  }
  media.sync().catch((err) => console.error('[files]', err.message));
  back('connected');
}));

// ── Everything below requires authentication ──────────────────────────────

router.use(auth.authenticate);

router.post('/auth/logout', wrap(async (req, res) => {
  await auth.logout(req);
  res.status(204).end();
}));

router.get('/auth/me', wrap(async (req, res) => {
  const { id, username, role, external_id, max_stations } = req.user;
  res.json({ id, username, role, external_id, max_stations, email: req.user.email || null, storage: await media.usage(req.user), authenticated_via: req.user.via });
}));

// An account may set where its own notices go. Everything else about an account is the administrator's.
router.patch('/auth/me', wrap(async (req, res) => {
  const body = req.body || {};
  const problem = body.email === undefined ? 'is required (empty to stop notices)' : v.checkEmail(body.email);
  if (problem) throw invalid([{ field: 'email', message: problem }]);
  const email = body.email === null || body.email === '' ? null : body.email.trim();
  await db.query('UPDATE users SET email = $1, updated_at = now() WHERE id = $2', [email, req.user.id]);
  audit(req, 'user.email', req.user.username);
  res.json({ id: req.user.id, username: req.user.username, email });
}));

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
  checkPlan(row);
  await media.checkAssignment(row, row.user_id, null);
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
  // Files belong to an account, so they do not follow a station to another one.
  if (fields.user_id !== undefined && fields.user_id !== current.user_id) {
    fields = { ident_file_id: null, fallback_file_id: null, artwork_file_id: null, ...fields };
  }
  checkPlan({ ...current, ...fields });
  await media.checkAssignment(fields, fields.user_id === undefined ? current.user_id : fields.user_id, current.slug);
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

// ── Uploaded files: idents, fallback audio and station images ─────────────

const fileId = (req) => v.intParam(req.params.id, { name: 'id', min: 1, max: 2147483647 });

async function loadFile(req) {
  const row = await media.find(fileId(req));
  if (!row || (!isAdmin(req) && row.user_id !== req.user.id)) throw notFound('File');
  return row;
}

// The account a file request is about: the caller's, or for an administrator the one named by user_id.
async function fileOwner(req) {
  if (req.query.user_id === undefined || Number(req.query.user_id) === req.user.id) return req.user;
  if (!isAdmin(req)) throw forbidden('Only administrators can manage the files of other accounts.');
  const id = v.intParam(req.query.user_id, { name: 'user_id', min: 1, max: 2147483647 });
  const { rows } = await db.query('SELECT id, username, role, storage_quota_mb FROM users WHERE id = $1', [id]);
  if (!rows[0]) throw invalid([{ field: 'user_id', message: 'does not match an existing user' }]);
  return rows[0];
}

async function presentFiles(rows) {
  if (!rows.length) return [];
  const used = await db.query(
    `SELECT slug, ident_file_id, fallback_file_id, artwork_file_id FROM stations
     WHERE ident_file_id = ANY($1) OR fallback_file_id = ANY($1) OR artwork_file_id = ANY($1) ORDER BY slug`,
    [rows.map((row) => row.id)]
  );
  return rows.map((row) => media.present(
    row,
    used.rows.flatMap((s) => [
      ...(s.ident_file_id === row.id ? [{ station: s.slug, as: 'ident' }] : []),
      ...(s.fallback_file_id === row.id ? [{ station: s.slug, as: 'fallback' }] : []),
      ...(s.artwork_file_id === row.id ? [{ station: s.slug, as: 'artwork' }] : []),
    ])
  ));
}

router.get('/files', wrap(async (req, res) => {
  const everyone = isAdmin(req) && req.query.user_id === 'all';
  const owner = everyone ? req.user : await fileOwner(req);
  const kind = req.query.kind === undefined || req.query.kind === '' ? null : req.query.kind;
  if (kind !== null && kind !== 'audio' && kind !== 'image') throw invalid([{ field: 'kind', message: 'must be "audio" or "image"' }]);
  const { rows } = await db.query(
    `SELECT ${media.COLUMNS} FROM media_files WHERE ($1::int IS NULL OR user_id = $1) AND ($2::text IS NULL OR kind = $2) ORDER BY name, id`,
    [everyone ? null : owner.id, kind]
  );
  res.json({
    files: await presentFiles(rows),
    usage: await media.usage(owner),
    limits: { ident_max_seconds: await settings.get('ident_max_seconds'), image_max_bytes: image.MAX_BYTES },
  });
}));

// The file is the request body itself; its details travel in the query string.
router.post('/files', wrap(async (req, res) => {
  try {
    const owner = await fileOwner(req);
    const errors = [];
    const original = String(req.query.filename || req.get('x-file-name') || '').replace(/[\u0000-\u001f\\/]/g, '').trim().slice(0, 255) || null;
    const name = String(req.query.name || (original || '').replace(/\.[A-Za-z0-9]{1,5}$/, '')).replace(/[\u0000-\u001f]/g, ' ').trim();
    if (!name || name.length > 100) errors.push({ field: 'name', message: 'must be 1-100 characters (pass ?name=, or ?filename= to use the file name)' });
    const use = req.query.use === undefined || req.query.use === '' ? null : req.query.use;
    if (use !== null && !['ident', 'fallback', 'artwork'].includes(use)) errors.push({ field: 'use', message: 'must be "ident", "fallback" or "artwork"' });
    let station = null;
    if (req.query.station) {
      station = await stations.findBySlug(String(req.query.station));
      if (!station || station.user_id !== owner.id) errors.push({ field: 'station', message: "is not a station in this file's account" });
      else if (!use) errors.push({ field: 'use', message: 'is required with "station": say whether the file is its "ident", its "fallback" or its "artwork"' });
    }
    if (errors.length) throw invalid(errors);

    // Converting replaces what was uploaded, so it is only done when the caller says so.
    const consent = req.query.convert === 'true' || req.query.convert === '1';
    const row = await media.create(req, owner, { name, originalName: original, use, station, consent });
    if (!row.already_stored) audit(req, 'file.upload', `file:${row.id}`, { name: row.name, size_bytes: row.size_bytes, user_id: owner.id, converting: row.status === 'converting' });
    // assign=false only checks the file against the station; the caller sets it on the station itself.
    if (station && req.query.assign !== 'false') await updateStation(req, station, { [`${use}_file_id`]: row.id });
    res.status(row.already_stored ? 200 : row.status === 'converting' ? 202 : 201).json({ ...(await presentFiles([row]))[0], already_stored: Boolean(row.already_stored), usage: await media.usage(owner) });
  } catch (err) {
    // The rest of the upload is not read, so this connection cannot be reused.
    res.set('Connection', 'close');
    res.once('finish', () => req.destroy());
    throw err;
  }
}));

router.get('/files/:id', wrap(async (req, res) => {
  res.json((await presentFiles([await loadFile(req)]))[0]);
}));

// Converts a file already in the library to a station's format. Calling this
// is the owner's agreement to it: the converted file takes the original's place
// on that station, and the original is removed if nothing else uses it.
router.post('/files/:id/convert', wrap(async (req, res) => {
  const file = await loadFile(req);
  const body = req.body || {};
  const station = typeof body.station === 'string' ? await stations.findBySlug(body.station) : null;
  if (!station || station.user_id !== file.user_id) throw invalid([{ field: 'station', message: "must be a station in this file's account" }]);
  if (body.use !== 'ident' && body.use !== 'fallback') throw invalid([{ field: 'use', message: 'must be "ident" or "fallback"' }]);
  const { rows } = await db.query('SELECT id, username, role, storage_quota_mb FROM users WHERE id = $1', [file.user_id]);
  const row = await media.convertExisting(file, rows[0], station, body.use);
  audit(req, 'file.convert', `file:${file.id}`, { station: station.slug, use: body.use, new_file: row.id });
  res.status(202).json((await presentFiles([row]))[0]);
}));

router.get('/files/:id/content', wrap(async (req, res) => {
  await media.send(res, await loadFile(req), { download: req.query.download !== undefined });
}));

router.patch('/files/:id', wrap(async (req, res) => {
  const current = await loadFile(req);
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
  if (!name || name.length > 100) throw invalid([{ field: 'name', message: 'must be 1-100 characters' }]);
  const { rows } = await db.query(`UPDATE media_files SET name = $1 WHERE id = $2 RETURNING ${media.COLUMNS}`, [name, current.id]);
  await stations.republishUser(current.user_id);
  audit(req, 'file.rename', `file:${current.id}`, { name });
  res.json((await presentFiles(rows))[0]);
}));

router.delete('/files/:id', wrap(async (req, res) => {
  const current = await loadFile(req);
  const inUse = await media.stationsUsing(current.id);
  if (inUse.length && req.query.force === undefined) {
    throw new HttpError(409, 'file_in_use', `This file is used by ${inUse.join(', ')}. Choose another file for ${inUse.length === 1 ? 'that station' : 'those stations'} first, or repeat the request with ?force to remove it from them.`, { stations: inUse });
  }
  await media.remove(current);
  await stations.republishUser(current.user_id);
  audit(req, 'file.delete', `file:${current.id}`, { name: current.name, removed_from: inUse });
  res.status(204).end();
}));

// ── Billing and limits ────────────────────────────────────────────────────

const BILLING_USER = 'id, username, role, email, storage_quota_mb, discount_percent';

// What an account's stations and storage cost, and how close each is to its limits.
// An account sees its own; an administrator names one with user_id, or gets them all.
router.get('/billing', wrap(async (req, res) => {
  if (!isAdmin(req)) return res.json(await billing.forAccount(req.user));
  if (req.query.user_id !== undefined) {
    const id = v.intParam(req.query.user_id, { name: 'user_id', min: 1, max: 2147483647 });
    const { rows } = await db.query(`SELECT ${BILLING_USER} FROM users WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound('User');
    return res.json(await billing.forAccount(rows[0]));
  }
  const { rows } = await db.query(`SELECT ${BILLING_USER} FROM users ORDER BY username`);
  const accounts = [];
  for (const user of rows) accounts.push(await billing.forAccount(user));
  const priced = accounts.filter((a) => a.monthly_total !== null);
  res.json({
    currency: accounts[0] ? accounts[0].currency : (await billing.rates()).currency,
    month: new Date().toISOString().slice(0, 7),
    monthly_total: priced.length ? Math.round(priced.reduce((sum, a) => sum + a.monthly_total, 0) * 100) / 100 : null,
    accounts,
  });
}));

// What a given number of listeners, bitrate and storage would cost per month.
router.get('/billing/quote', wrap(async (req, res) => {
  const number = (name, min, max, fallback) => {
    if (req.query[name] === undefined || req.query[name] === '') return fallback;
    const n = Number(req.query[name]);
    if (!Number.isFinite(n) || n < min || n > max) throw invalid([{ field: name, message: `must be a number from ${min} to ${max}` }]);
    return n;
  };
  const listeners = number('listeners', 0, 1e9);
  const bandwidth = number('bandwidth_gb', 0, 1e9);
  if (listeners === undefined && bandwidth === undefined) throw invalid([{ field: 'listeners', message: 'give listeners (a plan by listeners) or bandwidth_gb (a plan by bandwidth)' }]);
  res.json(await billing.quote({
    listeners: listeners || 0,
    bandwidth_gb: bandwidth || 0,
    bitrate_kbps: number('bitrate_kbps', 8, 2000, 128),
    storage_mb: number('storage_mb', 0, 1e9, 0),
    discount_percent: isAdmin(req) ? number('discount_percent', 0, 100, 0) : 0,
  }));
}));

// Month by month, what each of an account's stations sent and how many listened.
router.get('/billing/history', wrap(async (req, res) => {
  const months = v.intParam(req.query.months, { name: 'months', min: 1, max: 120, fallback: 12 });
  let userId = req.user.id;
  if (isAdmin(req) && req.query.user_id !== undefined) userId = v.intParam(req.query.user_id, { name: 'user_id', min: 1, max: 2147483647 });
  res.json({ user_id: userId, months: await billing.history(userId, months) });
}));

// The rates prices are worked out from: what a server costs, its size, the margin, and storage.
router.get('/billing/rates', auth.requireAdmin, wrap(async (req, res) => {
  res.json(await billing.describeRates());
}));

router.put('/billing/rates', auth.requireAdmin, wrap(async (req, res) => {
  const fields = v.parseRates(req.body);
  await settings.set({ billing: { ...(await billing.rates()), ...fields } });
  audit(req, 'billing.rates', null, fields);
  res.json(await billing.describeRates());
}));

// One station against its limits: what its owner watches.
router.get('/stations/:slug/limits', wrap(async (req, res) => {
  const row = await loadStation(req);
  const { rows } = await db.query(`SELECT ${BILLING_USER} FROM users WHERE id = $1`, [row.user_id]);
  const bill = await billing.forAccount(rows[0]);
  res.json({ ...bill.stations.find((s) => s.station === row.slug), currency: bill.currency, storage: bill.storage });
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

const USER_COLUMNS = 'id, username, role, external_id, max_stations, storage_quota_mb, storage_overage, storage_ceiling_mb, email, discount_percent, is_active, created_at, updated_at';
const users = express.Router();
users.use(auth.requireAdmin);

users.get('/', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}, (SELECT COUNT(*)::int FROM stations s WHERE s.user_id = users.id) AS station_count,
            (SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM media_files f WHERE f.user_id = users.id) AS storage_used_bytes
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
  const files = await db.query(`SELECT ${media.COLUMNS} FROM media_files WHERE user_id = $1`, [id]);
  const { rows } = await db.query('DELETE FROM users WHERE id = $1 RETURNING username', [id]);
  if (!rows[0]) throw notFound('User');
  await media.discard(files.rows);
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

// ── Settings and file storage (administrators only) ───────────────────────

const dropboxRedirect = (req) => `${stations.baseUrl(req)}/api/v1/storage/dropbox/callback`;

async function presentSettings(req) {
  const [all, state, stored] = await Promise.all([
    settings.all(),
    dropbox.state(),
    db.query("SELECT storage, COUNT(*)::int AS files, COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM media_files GROUP BY storage"),
  ]);
  const count = (where) => stored.rows.find((row) => row.storage === where) || { files: 0, bytes: 0 };
  return {
    ident_max_seconds: all.ident_max_seconds,
    default_storage_quota_mb: all.default_storage_quota_mb,
    // The master's own machine, for capacity estimates, where no engine beside it reports it.
    master_port_mbps: all.master_port_mbps || 1000,
    master_vcpus: all.master_vcpus || null,
    master_memory_gb: all.master_memory_gb || null,
    smtp: await mail.describe(),
    // Whether notices go out by themselves, at which levels, and how far apart.
    notices: await notify.preferences(),
    storage: {
      backend: state.refreshToken ? 'dropbox' : 'local',
      local: { files: count('local').files, bytes: count('local').bytes },
      cache_mb: config.fileCacheMb,
      dropbox: {
        app_key: state.appKey || null,
        // The secret is never returned.
        app_secret_set: Boolean(state.appSecret),
        connected: Boolean(state.refreshToken),
        account: state.account,
        files: count('dropbox').files,
        bytes: count('dropbox').bytes,
        // To be added to the app's "Redirect URIs" in the Dropbox developer console.
        redirect_uri: dropboxRedirect(req),
      },
    },
  };
}

router.get('/settings', auth.requireAdmin, wrap(async (req, res) => {
  res.json(await presentSettings(req));
}));

router.put('/settings', auth.requireAdmin, wrap(async (req, res) => {
  const fields = v.parseSettings(req.body);
  const before = await dropbox.state();
  const changesApp =
    (fields.dropbox_app_key !== undefined && (fields.dropbox_app_key || '') !== before.appKey) ||
    (fields.dropbox_app_secret !== undefined && (fields.dropbox_app_secret || '') !== before.appSecret);
  if (changesApp && before.refreshToken) {
    throw conflict('dropbox_connected', 'Disconnect Dropbox before changing its app key or secret.');
  }
  // Only the supplied parts of the mail settings change; the password stays unless a new one is given.
  if (fields.smtp) fields.smtp = { ...(await mail.smtp()), ...fields.smtp };
  if (fields.notices) fields.notices = { ...(await notify.preferences()), ...fields.notices };
  await settings.set(fields);
  audit(req, 'settings.update', null, {
    ...fields,
    ...(fields.dropbox_app_secret ? { dropbox_app_secret: '(set)' } : {}),
    ...(fields.smtp ? { smtp: { ...fields.smtp, password: fields.smtp.password ? '(set)' : '' } } : {}),
  });
  res.json(await presentSettings(req));
}));

// Sends a test message, to show that the mail settings work.
router.post('/settings/email/test', auth.requireAdmin, wrap(async (req, res) => {
  const to = req.body && req.body.to;
  if (!to || v.checkEmail(to)) throw invalid([{ field: 'to', message: 'must be an email address' }]);
  await mail.send({ to: to.trim(), subject: 'StreamNode test message', text: 'This message shows that StreamNode can send email with the settings you entered.\n' });
  audit(req, 'settings.email_test', to.trim());
  res.json({ sent: true, to: to.trim() });
}));

// Sends any notices that are due now, instead of waiting for the next round.
// This is also how notices are sent while the automatic ones are switched off.
router.post('/notifications/run', auth.requireAdmin, wrap(async (req, res) => {
  res.json(await notify.run({ force: true }));
}));

// Sends one account a summary of where its stations stand, on request.
router.post('/notifications/send', auth.requireAdmin, wrap(async (req, res) => {
  const body = req.body || {};
  let id = body.user_id;
  if (id === undefined && typeof body.station === 'string') {
    const row = await stations.findBySlug(body.station);
    if (!row) throw notFound('Station');
    id = row.user_id;
  }
  if (!Number.isInteger(id)) throw invalid([{ field: 'user_id', message: 'give a user_id, or a station slug' }]);
  const result = await notify.sendSummary(id);
  if (!result) throw notFound('User');
  if (!result.sent) throw conflict('no_email_address', result.reason);
  audit(req, 'notifications.send', `user:${id}`);
  res.json(result);
}));

router.get('/notifications', auth.requireAdmin, wrap(async (req, res) => {
  const limit = v.intParam(req.query.limit, { name: 'limit', min: 1, max: 500, fallback: 100 });
  const { rows } = await db.query(
    `SELECT n.id, n.sent_at, u.username, s.slug AS station, n.kind, n.threshold, n.period, n.recipient, n.subject
     FROM notifications n JOIN users u ON u.id = n.user_id LEFT JOIN stations s ON s.id = n.station_id ORDER BY n.id DESC LIMIT $1`, [limit]
  );
  res.json({ notifications: rows });
}));

// Starts the approval: the administrator opens the returned address and allows the app.
router.post('/storage/dropbox/authorize', auth.requireAdmin, wrap(async (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  const redirectUri = dropboxRedirect(req);
  const url = await dropbox.authorizeUrl(redirectUri, state);
  await redis.set(`dropbox:state:${state}`, redirectUri, { EX: 600 });
  audit(req, 'dropbox.authorize');
  res.json({ authorize_url: url, redirect_uri: redirectUri, expires_in: 600 });
}));

// Stops using Dropbox. Every file is first brought back to this server so
// that none is lost; the copies in Dropbox are left where they are.
router.delete('/storage/dropbox', auth.requireAdmin, wrap(async (req, res) => {
  const result = await media.bringHome();
  if (result.failed.length) {
    throw new HttpError(409, 'files_not_retrieved', `Dropbox was not disconnected because ${result.failed.length} file(s) could not be copied back to this server: ${result.failed[0].reason}`, result);
  }
  await dropbox.disconnect();
  audit(req, 'dropbox.disconnect', null, { files_returned: result.returned });
  res.json(await presentSettings(req));
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

// What adding a server of a given size would do to capacity, load and traffic.
router.post('/capacity/estimate', auth.requireAdmin, wrap(async (req, res) => {
  res.json(await capacity.estimate(v.parseCandidate(req.body)));
}));

router.get('/audit-log', auth.requireAdmin, wrap(async (req, res) => {
  const limit = v.intParam(req.query.limit, { name: 'limit', min: 1, max: 500, fallback: 100 });
  const { rows } = await db.query('SELECT id, at, username, action, target, detail, ip FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
  res.json({ entries: rows });
}));

router.use((req, res, next) => next(notFound('Endpoint')));

module.exports = router;
