// Enrolment of slave nodes (servers that run only the audio engine).
//
// A slave proves it may join by presenting a one-time join token. The master
// then registers it with HAProxy and hands back what the engine needs: the
// Redis endpoint and password, and the secret HAProxy sends with each request.
//
// Two ways to get a token to a slave:
//   - the administrator copies an install command containing it (slave-initiated)
//   - the administrator gives the master the slave's address and setup key,
//     and the master delivers a token bound to that address (master-initiated)

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const config = require('./config');
const db = require('./db');
const haproxy = require('./haproxy');
const security = require('./security');
const { HttpError, invalid, conflict } = require('./errors');

const TOKEN_PREFIX = 'rgj_';
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;
const HOST_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,253}[a-zA-Z0-9])?$/;

const rejected = (message) => new HttpError(403, 'join_refused', message);
const plainIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

async function createToken({ note = null, minutes = config.joinTokenMinutes, maxUses = 1, boundAddress = null, userId = null }) {
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO join_tokens (token_hash, token_prefix, note, bound_address, max_uses, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6), $7)
     RETURNING id, token_prefix, note, bound_address, max_uses, uses, expires_at, created_at`,
    [security.sha256(token), token.slice(0, 12), note, boundAddress, maxUses, minutes, userId]
  );
  return { ...rows[0], token };
}

async function addressesOf(host) {
  if (net.isIP(host)) return [host];
  try {
    return (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

// Checks and spends one use of a token, atomically.
async function consumeToken(client, token, fromIp) {
  const { rows } = await client.query('SELECT * FROM join_tokens WHERE token_hash = $1 FOR UPDATE', [security.sha256(String(token))]);
  const row = rows[0];
  if (!row) throw rejected('The join token is not valid.');
  if (row.expires_at < new Date()) throw rejected('The join token has expired. Create a new one on the master.');
  if (row.uses >= row.max_uses) throw rejected('The join token has already been used. Create a new one on the master.');
  if (row.bound_address && !(await addressesOf(row.bound_address)).map(plainIp).includes(fromIp)) {
    throw rejected(`This join token was issued for ${row.bound_address}, but the request came from ${fromIp}.`);
  }
  await client.query('UPDATE join_tokens SET uses = uses + 1 WHERE id = $1', [row.id]);
}

// Handles POST /cluster/join from a slave's engine.
async function join(body, fromIp) {
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!NAME_RE.test(name)) errors.push({ field: 'name', message: 'must be 1-50 letters, digits, ".", "_" or "-"' });
  const port = body.port === undefined ? 3000 : body.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push({ field: 'port', message: 'must be an integer from 1 to 65535' });
  const address = body.address === undefined || body.address === null || body.address === '' ? plainIp(fromIp) : String(body.address).trim().toLowerCase();
  if (!HOST_RE.test(address) && !net.isIP(address)) errors.push({ field: 'address', message: 'must be a hostname or IP address' });
  if (typeof body.token !== 'string' || !body.token) errors.push({ field: 'token', message: 'is required' });
  if (errors.length) throw invalid(errors);

  const client = await db.pool.connect();
  let node;
  try {
    await client.query('BEGIN');
    await consumeToken(client, body.token, plainIp(fromIp));
    const existing = await client.query('SELECT * FROM engine_nodes WHERE name = $1', [name]);
    if (existing.rows[0] && existing.rows[0].is_builtin) {
      throw conflict('name_taken', `"${name}" is the name of the engine on the master itself. Give this server another name.`);
    }
    // Re-joining under the same name (a rebuilt server) updates the entry.
    const saved = await client.query(
      `INSERT INTO engine_nodes (name, host, port, mode) VALUES ($1, $2, $3, 'proxied')
       ON CONFLICT (name) DO UPDATE SET host = EXCLUDED.host, port = EXCLUDED.port, mode = 'proxied', enabled = true, updated_at = now()
       RETURNING *`,
      [name, address, port]
    );
    node = saved.rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw conflict('address_taken', 'Another server is already registered at this address and port.');
    throw err;
  } finally {
    client.release();
  }

  db.query('INSERT INTO audit_log (username, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5)', [
    'join-token', 'server.join', node.name, JSON.stringify({ host: node.host, port: node.port }), plainIp(fromIp),
  ]).catch(() => {});
  // Put it in rotation now; the periodic sync covers a temporarily unreachable HAProxy.
  if (haproxy.enabled()) await haproxy.sync().catch(() => {});

  return {
    node: { id: node.id, name: node.name, address: node.host, port: node.port },
    redis: {
      host: config.clusterHost || null,
      port: config.clusterPort,
      password: config.redisPassword,
      tls: config.clusterTls,
      // HAProxy's own certificate matches the name slaves connect to only when
      // this server holds the domain's real certificate and slaves use that name.
      tls_verify: ['letsencrypt', 'provided'].includes(config.tlsMode) && !config.clusterHost,
    },
    engine_secret: config.engineSecret,
    settings: { allow_private_sources: config.allowPrivateSources },
  };
}

// Run in a copy of the project on the new server. (With the one-line
// bootstrap, the same options go after "bash -s --".)
function installCommand(masterUrl, token) {
  return `./install.sh --role slave --master ${masterUrl} --token ${token}`;
}

// Master-initiated enrolment: deliver a token to a slave that is waiting for setup.
async function enrolWaitingServer({ address, port, setupKey, masterUrl, userId }) {
  const created = await createToken({ note: `setup of ${address}`, minutes: 10, boundAddress: address, userId });
  const discard = () => db.query('DELETE FROM join_tokens WHERE id = $1', [created.id]).catch(() => {});
  let response;
  try {
    response = await fetch(`http://${address}:${port}/_cluster/configure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${setupKey}` },
      body: JSON.stringify({ master_url: masterUrl, token: created.token }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    await discard();
    throw new HttpError(502, 'server_unreachable', `Could not reach ${address}:${port}. Check the address, that the slave is installed and running, and that its firewall allows this master (${err.cause ? err.cause.code || err.cause.message : err.message}).`);
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    await discard();
    const hint = response.status === 503 ? 'That server is already set up or is not waiting for setup.' : answer.message || `It answered HTTP ${response.status}.`;
    throw new HttpError(response.status === 401 ? 422 : 502, 'setup_failed', hint);
  }
  const { rows } = await db.query("SELECT * FROM engine_nodes WHERE host = $1 AND port = $2 AND mode = 'proxied'", [address, port]);
  return rows[0] || null;
}

// The engine that ships with a single-server install is registered like any
// other; on a master-only install there is none, so the entry is removed.
async function ensureLocalEngine() {
  if (!config.localEngine) {
    await db.query('DELETE FROM engine_nodes WHERE is_builtin');
    return;
  }
  const [host, port] = config.localEngine.split(':');
  await db.query(
    `INSERT INTO engine_nodes (name, host, port, is_builtin) VALUES ('local', $1, $2, true)
     ON CONFLICT (name) DO UPDATE SET host = EXCLUDED.host, port = EXCLUDED.port, is_builtin = true, mode = 'proxied'`,
    [host, Number(port) || 3000]
  );
}

const overrideKey = (name) => `node:${name}:audio_override`;

// Engines read the override from Redis with every heartbeat. It is re-written
// from the database periodically, so it survives a Redis restart.
async function publishOverrides() {
  const { redis } = require('./cache');
  const { rows } = await db.query('SELECT name, audio_override FROM engine_nodes');
  await Promise.all(rows.map((row) => (row.audio_override ? redis.set(overrideKey(row.name), row.audio_override) : redis.del(overrideKey(row.name)))));
}

module.exports = { publishOverrides, createToken, join, installCommand, enrolWaitingServer, ensureLocalEngine, plainIp };
