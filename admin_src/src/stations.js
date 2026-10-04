const config = require('./config');
const db = require('./db');
const { redis } = require('./cache');
const streamTypes = require('./streamtypes');

const COLUMNS =
  'id, user_id, name, slug, primary_url, backup_url, metadata_url, artwork_url, max_listeners, external_id, is_active, failover_delay_secs, silence_detection, ident_file_id, fallback_file_id, billing_bitrate_kbps, discount_percent, price_override, subscription_ends_on, created_at, updated_at';

const profileKey = (slug) => `station:${slug}`;

// The ident and fallback files of the given stations, by id.
async function mediaFor(rows) {
  const ids = [...new Set(rows.flatMap((row) => [row.ident_file_id, row.fallback_file_id]).filter(Boolean))];
  if (!ids.length) return new Map();
  // A file that is still being converted, or could not be, is not offered to the engines.
  const found = await db.query("SELECT id, name, sha256 FROM media_files WHERE id = ANY($1) AND status = 'ready'", [ids]);
  return new Map(found.rows.map((file) => [file.id, file]));
}

function profile(row, media) {
  const out = {};
  for (const [prefix, id] of [['ident', row.ident_file_id], ['fallback', row.fallback_file_id]]) {
    const file = id && media.get(id);
    if (!file) continue;
    out[`${prefix}_id`] = String(file.id);
    // The engine fetches a file again when this changes.
    out[`${prefix}_ver`] = file.sha256.slice(0, 16);
    out[`${prefix}_name`] = file.name;
  }
  return {
    ...out,
    failover_delay: String(row.failover_delay_secs),
    silence: row.silence_detection ? '1' : '0',
    name: row.name,
    primary: row.primary_url,
    backup: row.backup_url || '',
    metadata_url: row.metadata_url || '',
    artwork_url: row.artwork_url || '',
    max_listeners: String(row.max_listeners),
    active: row.is_active ? '1' : '0',
  };
}

// The engine routes from Redis only, so every change is mirrored there.
async function publish(row, media) {
  const key = profileKey(row.slug);
  await redis.multi().del(key).hSet(key, profile(row, media || (await mediaFor([row])))).exec();
}

// After a file is renamed or removed, the stations that used it are published again.
async function republishUser(userId) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM stations WHERE user_id = $1`, [userId]);
  const media = await mediaFor(rows);
  await Promise.all(rows.map((row) => publish(row, media)));
}

async function unpublish(slug) {
  await redis.del(profileKey(slug));
}

// Rebuilds the whole registry from PostgreSQL. Runs at start-up and
// periodically, so a wiped or restarted Redis heals without intervention.
async function syncAll() {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM stations`);
  const wanted = new Set(rows.map((row) => profileKey(row.slug)));
  const media = await mediaFor(rows);
  await Promise.all(rows.map((row) => publish(row, media)));
  const stale = [];
  for await (const key of redis.scanIterator({ MATCH: 'station:*', COUNT: 500 })) {
    if (!wanted.has(key)) stale.push(key);
  }
  if (stale.length) await redis.del(stale);
  return rows.length;
}

const OFFLINE = Object.freeze({
  online: false, listeners: 0, source: null, title: null, artist: null, artwork: null,
  content_type: null, bitrate: null, connected_since: null, servers: 0,
  no_audio_on: [], source_offline: false, stream_format: null,
});
const NODE_ALIVE_SECS = 15;

// Engines announce themselves in engine:nodes; one that stopped is ignored
// even if its last live:* keys have not expired yet.
async function activeNodes() {
  const now = Math.floor(Date.now() / 1000);
  return redis.zRangeByScore('engine:nodes', now - NODE_ALIVE_SECS, '+inf');
}

// Combines one station's state from every engine relaying it. Listeners add
// up; a station counts as on its fallback file, or else its backup, if any
// engine is.
function mergeLive(hashes) {
  const onAir = hashes.filter((h) => h && h.source && h.source !== 'none');
  if (!onAir.length) return { ...OFFLINE };
  const first = onAir[0];
  const started = Math.min(...onAir.map((h) => Number(h.started_at)).filter(Boolean));
  return {
    online: true,
    listeners: onAir.reduce((sum, h) => sum + (parseInt(h.listeners, 10) || 0), 0),
    source: ['fallback', 'backup'].find((source) => onAir.some((h) => h.source === source)) || 'primary',
    title: first.title || null,
    artist: first.artist || null,
    artwork: first.artwork || null,
    content_type: first.content_type || null,
    bitrate: parseInt(first.bitrate, 10) || null,
    connected_since: Number.isFinite(started) ? new Date(started * 1000).toISOString() : null,
    servers: onAir.length,
    no_audio_on: [],
    source_offline: false,
    stream_format: null,
  };
}

// What the engines last saw each stream to be, and which features apply to
// it. Uploaded audio has to match it.
const streamFormat = streamTypes.describe;

// Servers that have given up on a station because its sources deliver no
// audio there. Each engine publishes its own list as silent:<node>.
function silentServers(slug, nodes, silentByNode) {
  const out = [];
  nodes.forEach((node, i) => {
    const entry = silentByNode[i] && silentByNode[i][slug];
    if (!entry) return;
    const cut = entry.indexOf('|');
    const since = Number(entry.slice(0, cut));
    out.push({ server: node, since: since ? new Date(since * 1000).toISOString() : null, reason: entry.slice(cut + 1) || null });
  });
  return out;
}

async function liveFor(slugs) {
  const nodes = slugs.length ? await activeNodes() : [];
  const [perSlug, silentByNode, formats] = await Promise.all([
    Promise.all(slugs.map((slug) => Promise.all(nodes.map((node) => redis.hGetAll(`live:${slug}:${node}`))))),
    Promise.all(nodes.map((node) => redis.hGetAll(`silent:${node}`))),
    Promise.all(slugs.map((slug) => redis.hGetAll(`format:${slug}`))),
  ]);
  return new Map(slugs.map((slug, i) => {
    const live = mergeLive(perSlug[i]);
    live.no_audio_on = silentServers(slug, nodes, silentByNode);
    // Every server that could play it has found its sources silent.
    live.source_offline = !live.online && nodes.length > 0 && live.no_audio_on.length === nodes.length;
    live.stream_format = streamFormat(formats[i]);
    return [slug, live];
  }));
}

// The origin to put in stream URLs and install commands. Normally the
// configured public address. A request made to the server's IP address (the
// local network, or a server without a domain) gets URLs on that same address,
// so what the dashboard shows is reachable from where it is being viewed.
function baseUrl(req) {
  const host = req.get('host') || '';
  const byAddress = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|localhost)(:\d+)?$/i.test(host);
  if (config.publicBaseUrl && !byAddress) return config.publicBaseUrl;
  return `${req.protocol}://${host}`;
}

function present(row, live, req) {
  const stream = `${baseUrl(req)}/${row.slug}`;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    user_id: row.user_id,
    external_id: row.external_id,
    primary_url: row.primary_url,
    backup_url: row.backup_url,
    metadata_url: row.metadata_url,
    artwork_url: row.artwork_url,
    max_listeners: row.max_listeners,
    is_active: row.is_active,
    failover_delay_secs: row.failover_delay_secs,
    silence_detection: row.silence_detection,
    ident_file_id: row.ident_file_id,
    fallback_file_id: row.fallback_file_id,
    billing_bitrate_kbps: row.billing_bitrate_kbps,
    discount_percent: Number(row.discount_percent),
    price_override: row.price_override === null ? null : Number(row.price_override),
    subscription_ends_on: row.subscription_ends_on,
    stream_url: stream,
    playlist_urls: { m3u: `${stream}.m3u`, pls: `${stream}.pls` },
    live: live || { ...OFFLINE },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findBySlug(slug) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM stations WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

module.exports = { COLUMNS, publish, republishUser, streamFormat, unpublish, syncAll, liveFor, mergeLive, silentServers, activeNodes, present, baseUrl, findBySlug };
