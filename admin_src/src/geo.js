// Listener countries: where listeners are, what they listen on, and which
// countries a station may be heard in. Off unless GEO_ENABLED=true.
//
// HAProxy does the work at the door (haproxy.cfg, the GEO_ENABLED block):
// it looks each listener's address up in country.map, refuses a station's
// blocked countries with 451, and when a listening session ends it sends one
// log line here over UDP. This module
//   - keeps the map files (shared with HAProxy) and HAProxy's copies in memory
//     in step with the stations' rules,
//   - downloads the country database (DB-IP "IP to Country Lite", CC BY 4.0)
//     and turns it into country.map,
//   - counts the logged sessions per station, day, country and device.

const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const config = require('./config');

const MAPS = ['country', 'blocked', 'allowlist', 'allowed'];
const MODES = ['off', 'block', 'allow'];
const UNKNOWN = 'ZZ';
const DAY_MS = 86400000;

const enabled = () => config.geoEnabled;
const localFile = (name) => path.join(config.geoDir, `${name}.map`);
// The same file as HAProxy names it, which is how its runtime API refers to a map.
const haproxyFile = (name) => `${config.geoHaproxyDir}/${name}.map`;

// ── Pure helpers (tested) ────────────────────────────────────────────────────

/** What kind of device a player is, from its User-Agent. */
function deviceOf(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s || s === '-') return 'unknown';
  if (/alexa|echo|sonos|google-?home|googlecast|crkey|bose|homepod|audioaccessory/.test(s)) return 'smart speaker';
  if (/carplay|android ?auto|automotive|tesla|\bcar\b/.test(s)) return 'car';
  if (/smart-?tv|tizen|webos|roku|appletv|apple tv|aft[a-z]|firetv|android ?tv|bravia|hbbtv/.test(s)) return 'tv';
  if (/ipad|tablet|kindle|silk\//.test(s)) return 'tablet';
  if (/iphone|ipod|android|mobile|windows phone|blackberry/.test(s)) return 'mobile';
  if (/vlc|winamp|foobar|itunes|mpv|mplayer|lavf|ffmpeg|gstreamer|bass\/|tunein|radio|player|streamripper|icecast|libmpg/.test(s)) return 'player app';
  if (/windows|macintosh|mac os x|x11|linux|cros/.test(s)) return 'desktop';
  return 'other';
}

/**
 * Reads one HAProxy log line of a finished request (the GEO_ENABLED log-format).
 * Returns { slug, country, device, seconds, bytes } for a stream that was
 * served (status 200 from a streaming server), or null.
 */
function parseLogLine(line) {
  const m = /\s(\S+)\/(\S+) (-?\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+) (\d{3}) (\d+) .* audience="([^"]*)","([^"]*)","([^"]*)"\s*$/.exec(line);
  if (!m) return null;
  const [, backend, server, , , , , active, status, bytes, slug, country, ua] = m;
  if (status !== '200' || server === '<NOSRV>' || !slug || backend !== config.haproxyBackend) return null;
  const ms = Number(active);
  return {
    slug,
    country: /^[A-Z]{2}$/.test(country) ? country : UNKNOWN,
    device: deviceOf(ua),
    seconds: Math.max(0, Math.round(ms / 1000)),
    bytes: Number(bytes) || 0,
  };
}

/** The station rules as HAProxy map entries. Allow-lists only once countries are known. */
function ruleEntries(stations, { countriesLoaded }) {
  const blocked = [];
  const allowlist = [];
  const allowed = [];
  for (const s of stations) {
    const countries = [...new Set((s.geo_countries || []).map((c) => String(c).toUpperCase()))].sort();
    if (s.geo_mode === 'block') for (const c of countries) blocked.push(`${s.slug}|${c}`);
    if (s.geo_mode === 'allow' && countriesLoaded) {
      allowlist.push(s.slug);
      for (const c of countries) allowed.push(`${s.slug}|${c}`);
    }
  }
  return { blocked: blocked.sort(), allowlist: allowlist.sort(), allowed: allowed.sort() };
}

// IPv4 range to the fewest CIDR blocks covering exactly it.
function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}
function intToIpv4(n) {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');
}
function ipv4RangeToCidrs(start, end) {
  let lo = ipv4ToInt(start);
  const hi = ipv4ToInt(end);
  const out = [];
  while (lo <= hi) {
    let bits = 0;
    while (bits < 32 && lo % 2 ** (bits + 1) === 0 && lo + 2 ** (bits + 1) - 1 <= hi) bits += 1;
    out.push(`${intToIpv4(lo)}/${32 - bits}`);
    lo += 2 ** bits;
  }
  return out;
}

// IPv6 the same way, with BigInt.
function ipv6ToBig(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const parts = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return parts.reduce((n, p) => (n << 16n) + BigInt(parseInt(p || '0', 16)), 0n);
}
function bigToIpv6(n) {
  const parts = [];
  for (let i = 0; i < 8; i += 1) parts.unshift((n & 0xffffn).toString(16)), (n >>= 16n);
  return parts.join(':');
}
function ipv6RangeToCidrs(start, end) {
  let lo = ipv6ToBig(start);
  const hi = ipv6ToBig(end);
  const out = [];
  while (lo <= hi) {
    let bits = 0n;
    while (bits < 128n && lo % (1n << (bits + 1n)) === 0n && lo + (1n << (bits + 1n)) - 1n <= hi) bits += 1n;
    out.push(`${bigToIpv6(lo)}/${128n - bits}`);
    lo += 1n << bits;
  }
  return out;
}

/** Map lines ("cidr CC") from DB-IP's country CSV (start,end,country). */
function csvToMapLines(text) {
  const lines = [];
  for (const row of text.split('\n')) {
    const [start, end, cc] = row.trim().replace(/"/g, '').split(',');
    if (!start || !end || !/^[A-Z]{2}$/.test(cc || '')) continue;
    if (net.isIPv4(start) && net.isIPv4(end)) for (const c of ipv4RangeToCidrs(start, end)) lines.push(`${c} ${cc}`);
    else if (net.isIPv6(start) && net.isIPv6(end)) for (const c of ipv6RangeToCidrs(start, end)) lines.push(`${c} ${cc}`);
  }
  return lines;
}

/** The download address for a month: {YYYY} and {MM} are filled in. */
function databaseUrl(template, when = new Date()) {
  return String(template)
    .replace('{YYYY}', String(when.getUTCFullYear()))
    .replace('{MM}', String(when.getUTCMonth() + 1).padStart(2, '0'));
}

// ── Files and HAProxy ────────────────────────────────────────────────────────

async function writeAtomic(name, lines) {
  const target = localFile(name);
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, lines.length ? `${lines.join('\n')}\n` : '');
  await fs.promises.rename(tmp, target);
}

/** Creates any missing map file, so HAProxy can start with GEO_ENABLED. */
async function ensureFiles() {
  if (!enabled()) return;
  await fs.promises.mkdir(config.geoDir, { recursive: true });
  for (const name of MAPS) {
    await fs.promises.access(localFile(name)).catch(() => fs.promises.writeFile(localFile(name), ''));
  }
}

// One runtime API conversation: commands separated by newlines, answers read until HAProxy closes.
function runtime(text) {
  return new Promise((resolve, reject) => {
    if (!config.haproxyAdmin) return resolve('');
    const [host, port] = config.haproxyAdmin.split(':');
    const socket = net.createConnection({ host, port: Number(port) || 9999 });
    let out = '';
    socket.setTimeout(60000, () => socket.destroy(new Error('HAProxy runtime API timed out')));
    socket.on('connect', () => socket.end(`${text}\n`));
    socket.on('data', (chunk) => { out += chunk; });
    socket.on('end', () => resolve(out.trim()));
    socket.on('error', reject);
  });
}

/** Replaces HAProxy's copy of a map with these "key value" lines, in one transaction. */
async function loadIntoHaproxy(name, lines) {
  if (!config.haproxyAdmin) return;
  const file = haproxyFile(name);
  const answer = await runtime(`prepare map ${file}`);
  const version = (/New version created: (\d+)/.exec(answer) || [])[1];
  if (!version) throw new Error(`HAProxy did not prepare ${name}.map: ${answer || 'no answer'}`);
  // A command must fit HAProxy's buffer (tune.bufsize, 16 kB by default).
  const BATCH = 400;
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
    const reply = await runtime(`add map @${version} ${file} <<\n${chunk.join('\n')}\n`);
    if (reply && !/^\s*$/.test(reply)) throw new Error(`HAProxy refused ${name}.map entries: ${reply.slice(0, 200)}`);
  }
  await runtime(`commit map @${version} ${file}`);
}

// ── Country database ─────────────────────────────────────────────────────────

let state = { countries_loaded: false, entries: 0, source: null, loaded_at: null, error: null };

async function readState() {
  try {
    const stat = await fs.promises.stat(localFile('country'));
    if (stat.size > 0 && !state.countries_loaded) {
      state = { ...state, countries_loaded: true, loaded_at: stat.mtime.toISOString(), source: state.source || 'country.map' };
    }
  } catch {
    // no file yet
  }
  return state;
}

/** Downloads the country database and loads it. Kept as it is when the download fails. */
async function refreshCountries({ settings, force = false } = {}) {
  if (!enabled()) return state;
  await readState();
  const ageDays = state.loaded_at ? (Date.now() - Date.parse(state.loaded_at)) / DAY_MS : Infinity;
  if (!force && ageDays < 28) return state;
  const template = settings ? await settings.get('geo_database_url') : null;
  if (!template) return state;
  // The new month's file can appear a day or two late: fall back to last month's.
  const now = new Date();
  const candidates = [databaseUrl(template, now), databaseUrl(template, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)))];
  let lastError = null;
  for (const url of [...new Set(candidates)]) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      let body = Buffer.from(await res.arrayBuffer());
      if (url.endsWith('.gz') || (body[0] === 0x1f && body[1] === 0x8b)) body = zlib.gunzipSync(body);
      const lines = csvToMapLines(body.toString('utf8'));
      if (lines.length < 1000) throw new Error(`${url} held only ${lines.length} address ranges`);
      // HAProxy first: the file is what says the countries are loaded.
      await loadIntoHaproxy('country', lines);
      await writeAtomic('country', lines);
      state = { countries_loaded: true, entries: lines.length, source: url, loaded_at: new Date().toISOString(), error: null };
      console.log(`[geo] loaded ${lines.length} address blocks from ${url}`);
      return state;
    } catch (err) {
      lastError = err;
    }
  }
  state = { ...state, error: lastError ? lastError.message : 'no download address' };
  console.error('[geo] country database not updated:', state.error);
  return state;
}

// ── Station rules ────────────────────────────────────────────────────────────

let lastRules = null;

/** Writes the rule maps and loads them into HAProxy when they changed (or `force`). */
async function syncRules(db, { force = false } = {}) {
  if (!enabled()) return null;
  await readState();
  const { rows } = await db.query("SELECT slug, geo_mode, geo_countries FROM stations WHERE geo_mode <> 'off'");
  const rules = ruleEntries(rows, { countriesLoaded: state.countries_loaded });
  const signature = JSON.stringify(rules);
  if (!force && signature === lastRules) return rules;
  // Allowed countries before the allow-lists, so a station is never briefly allow-listed with nothing allowed.
  for (const [name, keys] of [['allowed', rules.allowed], ['blocked', rules.blocked], ['allowlist', rules.allowlist]]) {
    const lines = keys.map((k) => `${k} 1`);
    await loadIntoHaproxy(name, lines);
    await writeAtomic(name, lines);
  }
  lastRules = signature;
  return rules;
}

/** What a station's rule does right now, for the API. */
function statusFor(row) {
  if (!row.geo_mode || row.geo_mode === 'off') return 'off';
  if (!enabled()) return 'inactive: GEO_ENABLED is not set on this server';
  if (row.geo_mode === 'allow' && !state.countries_loaded) return 'inactive: the country database is not loaded yet';
  return 'active';
}

// ── Audience ─────────────────────────────────────────────────────────────────

const pending = new Map(); // "slug|day|dimension|key" -> { sessions, seconds }

function count(entry, day = new Date().toISOString().slice(0, 10)) {
  for (const [dimension, key] of [['country', entry.country], ['device', entry.device]]) {
    const id = `${entry.slug}|${day}|${dimension}|${key}`;
    const item = pending.get(id) || { sessions: 0, seconds: 0 };
    item.sessions += 1;
    item.seconds += entry.seconds;
    pending.set(id, item);
  }
}

function listen() {
  if (!enabled()) return null;
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg) => {
    for (const line of msg.toString('utf8').split('\n')) {
      const entry = parseLogLine(line);
      if (entry) count(entry);
    }
  });
  socket.on('error', (err) => console.error('[geo] audience listener:', err.message));
  socket.bind(config.audiencePort, () => console.log(`[geo] counting listener sessions from HAProxy on UDP ${config.audiencePort}`));
  return socket;
}

/** Adds what was counted to station_audience_daily. */
async function flush(db) {
  if (!pending.size) return 0;
  const items = [...pending.entries()];
  pending.clear();
  const slugs = [...new Set(items.map(([id]) => id.split('|')[0]))];
  const { rows } = await db.query('SELECT id, slug FROM stations WHERE slug = ANY($1)', [slugs]);
  const ids = new Map(rows.map((r) => [r.slug, r.id]));
  let written = 0;
  for (const [id, figures] of items) {
    const [slug, day, dimension, key] = id.split('|');
    if (!ids.has(slug)) continue;
    await db.query(
      `INSERT INTO station_audience_daily (station_id, day, dimension, key, sessions, listener_seconds)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (station_id, day, dimension, key)
       DO UPDATE SET sessions = station_audience_daily.sessions + EXCLUDED.sessions,
                     listener_seconds = station_audience_daily.listener_seconds + EXCLUDED.listener_seconds`,
      [ids.get(slug), day, dimension, key, figures.sessions, figures.seconds]
    );
    written += 1;
  }
  return written;
}

/** Days of listeners by country and device for one station (UTC days, inclusive). */
async function audience(db, stationId, from, to) {
  const { rows } = await db.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, dimension, key, sessions, listener_seconds
     FROM station_audience_daily WHERE station_id = $1 AND day >= $2::date AND day <= $3::date ORDER BY day, dimension, key`,
    [stationId, from, to]
  );
  const days = new Map();
  for (const r of rows) {
    const day = days.get(r.day) || { day: r.day, country: {}, device: {} };
    day[r.dimension][r.key] = { sessions: Number(r.sessions), listener_hours: Math.round((Number(r.listener_seconds) / 3600) * 100) / 100 };
    days.set(r.day, day);
  }
  return [...days.values()];
}

const capabilities = () => (enabled() ? ['listener_audience', 'geo_blocking'] : []);

module.exports = {
  MODES, UNKNOWN, enabled, deviceOf, parseLogLine, ruleEntries, ipv4RangeToCidrs, ipv6RangeToCidrs, csvToMapLines, databaseUrl,
  ensureFiles, refreshCountries, syncRules, statusFor, listen, count, flush, audience, capabilities, readState,
  state: () => state,
};
