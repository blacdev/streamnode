const config = require('./config');
const db = require('./db');
const { redis } = require('./cache');
const streamTypes = require('./streamtypes');

const COLUMNS =
  'id, user_id, name, slug, primary_url, backup_url, metadata_url, artwork_url, max_listeners, external_id, is_active, failover_delay_secs, silence_detection, noise_detection, silence_threshold_db, ident_file_id, fallback_file_id, default_title, default_artist, artwork_file_id, backup_titles_from_primary, billing_bitrate_kbps, discount_percent, price_override, subscription_ends_on, overage_mode, listener_ceiling, plan_type, bandwidth_gb, blocked, created_at, updated_at';

const profileKey = (slug) => `station:${slug}`;

// Where anyone can fetch a station's uploaded image. `version` names its
// content, so that a changed image is a changed address.
const artworkPath = (slug, version) => `/api/v1/public/stations/${slug}/artwork${version ? `?v=${version}` : ''}`;

// The ident, fallback and image files of the given stations, by id.
async function mediaFor(rows) {
  const ids = [...new Set(rows.flatMap((row) => [row.ident_file_id, row.fallback_file_id, row.artwork_file_id]).filter(Boolean))];
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
  const picture = row.artwork_file_id && media.get(row.artwork_file_id);
  return {
    ...out,
    // Shown when the stream and the metadata URL name nothing, and while the fallback file plays.
    default_title: row.default_title || '',
    default_artist: row.default_artist || '',
    // Players need a full address; without a public address set, the path is all that can be given.
    default_artwork: picture ? `${config.publicBaseUrl || ''}${artworkPath(row.slug, picture.sha256.slice(0, 12))}` : '',
    failover_delay: String(row.failover_delay_secs),
    silence: row.silence_detection ? '1' : '0',
    noise: row.noise_detection ? '1' : '0',
    // Empty leaves the engine on its own setting.
    silence_db: row.silence_threshold_db === null ? '' : String(row.silence_threshold_db),
    name: row.name,
    primary: row.primary_url,
    backup: row.backup_url || '',
    metadata_url: row.metadata_url || '',
    // Whose titles the backup shows: the metadata URL's, like the primary, or its own stream's.
    backup_titles: row.backup_titles_from_primary ? 'primary' : 'stream',
    artwork_url: row.artwork_url || '',
    // What the engines enforce. With pay as you go, listeners beyond the subscription's
    // number are let in, up to the ceiling if there is one (0 is no limit at all).
    max_listeners: String(enforcedListeners(row)),
    // A capped bandwidth plan that has used its month's allowance is off the air, like a suspended station.
    active: row.is_active && !row.blocked ? '1' : '0',
  };
}

// How many listeners the engines let in at once. A bandwidth plan has no such
// number, and pay as you go lets listeners in beyond the subscription's; both
// stop only at the ceiling, if one is set (0 is no limit at all).
function enforcedListeners(row) {
  if (row.plan_type === 'bandwidth') return row.listener_ceiling || 0;
  if (row.overage_mode === 'pay_as_you_go' && row.max_listeners > 0) return row.listener_ceiling || 0;
  return row.max_listeners;
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
  online: false, listeners: 0, source: null, title: null, artist: null, artwork: null, title_from: null,
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
    // Where the title came from: metadata_url, stream, station (its own) or file.
    title_from: first.title_from || null,
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

// Artwork an engine could only name by its path here is completed with the address being used.
const absolute = (url, req) => (url && url.startsWith('/') ? `${baseUrl(req)}${url}` : url);

// The station's title, artist and artwork as a visitor should see them: what
// is on air, and for whatever is missing there, the station's own.
function shown(row, live, req) {
  const none = !live.title && !live.artist;
  return {
    title: none ? row.default_title : live.title,
    artist: none ? row.default_artist : live.artist,
    title_from: none ? (row.default_title || row.default_artist ? 'station' : null) : live.title_from,
    artwork: absolute(live.artwork, req) || row.artwork_url || (row.artwork_file_id ? `${baseUrl(req)}${artworkPath(row.slug)}` : null),
  };
}

function present(row, live, req) {
  const stream = `${baseUrl(req)}/${row.slug}`;
  if (live && live.artwork) live = { ...live, artwork: absolute(live.artwork, req) };
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
    noise_detection: row.noise_detection,
    silence_threshold_db: row.silence_threshold_db,
    ident_file_id: row.ident_file_id,
    fallback_file_id: row.fallback_file_id,
    default_title: row.default_title,
    default_artist: row.default_artist,
    artwork_file_id: row.artwork_file_id,
    backup_titles_from_primary: row.backup_titles_from_primary,
    // Where the uploaded image can be fetched by anyone, when there is one.
    default_artwork_url: row.artwork_file_id ? `${baseUrl(req)}${artworkPath(row.slug)}` : null,
    billing_bitrate_kbps: row.billing_bitrate_kbps,
    discount_percent: Number(row.discount_percent),
    price_override: row.price_override === null ? null : Number(row.price_override),
    subscription_ends_on: row.subscription_ends_on,
    overage_mode: row.overage_mode,
    listener_ceiling: row.listener_ceiling,
    plan_type: row.plan_type,
    bandwidth_gb: row.bandwidth_gb === null ? null : Number(row.bandwidth_gb),
    // Why the station is off the air although it is not suspended: 'bandwidth' when its month's allowance is used up.
    blocked: row.blocked,
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

module.exports = { COLUMNS, publish, republishUser, streamFormat, unpublish, syncAll, liveFor, mergeLive, silentServers, activeNodes, present, shown, baseUrl, findBySlug };
