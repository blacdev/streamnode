// The upload library: station idents and the files played when a station's
// streams have no audio.
//
// Every file has a row in media_files and, while it is needed, a copy in
// FILES_DIR named by its id. With Dropbox connected the copy in Dropbox is the
// permanent one and the local copy is a cache that is trimmed to
// FILE_CACHE_MB; without it the local copy is the only one and is never
// removed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { pipeline, finished } = require('stream/promises');
const config = require('./config');
const db = require('./db');
const { redis } = require('./cache');
const audio = require('./audio');
const dropbox = require('./dropbox');
const settings = require('./settings');
const stations = require('./stations');
const { HttpError, invalid } = require('./errors');

const MB = 1024 * 1024;
const COLUMNS =
  'id, user_id, name, original_name, size_bytes, codec, sample_rate, channels, bitrate_kbps, constant_bitrate, duration_seconds, audio_offset, audio_bytes, sha256, storage, storage_path, created_at';
// Disk space that uploads never eat into.
const DISK_RESERVE = 512 * MB;

const localPath = (id) => path.join(config.filesDir, String(id));
const tmpDir = () => path.join(config.filesDir, 'tmp');
const refuse = (status, code, message, details) => new HttpError(status, code, message, details);

function size(bytes) {
  if (bytes >= 1024 * MB) return `${(bytes / 1024 / MB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function init() {
  await fs.promises.rm(tmpDir(), { recursive: true, force: true });
  await fs.promises.mkdir(tmpDir(), { recursive: true });
}

// ── Quotas ──────────────────────────────────────────────────────────────────

// Bytes an account may hold. Administrators are not limited.
async function quotaBytes(user) {
  if (user.role === 'admin') return null;
  const mb = user.storage_quota_mb === null || user.storage_quota_mb === undefined ? await settings.get('default_storage_quota_mb') : user.storage_quota_mb;
  return mb * MB;
}

async function usedBytes(userId, client = db) {
  const { rows } = await client.query('SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used FROM media_files WHERE user_id = $1', [userId]);
  return rows[0].used;
}

async function usage(user) {
  const [quota, used] = await Promise.all([quotaBytes(user), usedBytes(user.id)]);
  return { used_bytes: used, quota_bytes: quota, free_bytes: quota === null ? null : Math.max(0, quota - used) };
}

function overQuota(fileBytes, used, quota) {
  const free = Math.max(0, quota - used);
  return refuse(
    413,
    'quota_exceeded',
    `This file is ${size(fileBytes)} but only ${size(free)} of this account's ${size(quota)} of storage is free. Delete files that are no longer needed, or ask the administrator to raise the storage quota.`,
    { file_bytes: fileBytes, used_bytes: used, quota_bytes: quota, free_bytes: free }
  );
}

// ── Format checks ───────────────────────────────────────────────────────────

const describeFile = (row) => audio.describe(row);

// What an engine last saw the station's stream to be (format:<slug>).
const streamFormat = async (slug) => stations.streamFormat(await redis.hGetAll(`format:${slug}`));

/**
 * Why a file cannot be used on a station, as a sentence that also says what
 * to do; null when it can. `format` is the station's stream format, or null
 * while it is not known (the station has never been on air).
 */
function problemFor(file, use, format, identMaxSeconds) {
  if (use === 'ident' && Number(file.duration_seconds) > identMaxSeconds) {
    return `"${file.name}" is ${Number(file.duration_seconds).toFixed(1)} seconds long and an ident may be at most ${identMaxSeconds} seconds. Shorten it and upload it again.`;
  }
  if (!format) return null;
  if (!format.codec) {
    return `"${file.name}" cannot be used on this station: its stream is ${format.content_type || 'in a format'} that the gateway relays as it is, and idents and fallback audio work only on MP3 and AAC streams.`;
  }
  const problems = audio.mismatches(file, format);
  if (!problems.length) return null;
  return `"${file.name}" cannot be played on this station because ${problems.join(', and ')}. The gateway does not convert audio, so the file has to match the stream exactly: export it as ${audio.target(format)} and upload it again.`;
}

// ── Uploads ─────────────────────────────────────────────────────────────────

// Streams the request body to a temporary file, stopping as soon as it is
// larger than allowed.
async function receive(req, limit, onTooLarge) {
  const tmp = path.join(tmpDir(), crypto.randomBytes(12).toString('hex'));
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const out = fs.createWriteStream(tmp);
  try {
    // The request is left open on failure so that the refusal can still be sent on it.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > limit) throw onTooLarge(bytes);
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    await fs.promises.rm(tmp, { force: true });
    if (err instanceof HttpError) throw err;
    throw refuse(400, 'upload_interrupted', 'The upload was interrupted before the whole file arrived. Try again.');
  }
  return { tmp, bytes, sha256: hash.digest('hex') };
}

/**
 * Receives an upload for `owner`, checks it and stores it.
 * `use` ('ident' | 'fallback') and `station` (a row) are optional: with them
 * the file is also checked for that use on that station before it is kept.
 */
async function create(req, owner, { name, originalName, use, station }) {
  const quota = await quotaBytes(owner);
  const used = await usedBytes(owner.id);
  const declared = parseInt(req.get('content-length'), 10);
  const disk = await fs.promises.statfs(config.filesDir).catch(() => null);
  const diskFree = disk ? disk.bavail * disk.bsize - DISK_RESERVE : Infinity;
  const diskFull = () => refuse(507, 'server_storage_full', 'The server does not have enough disk space for this file. Ask the administrator to free some space.');

  // Refuse before reading anything when the size is already known to be too much.
  if (Number.isFinite(declared)) {
    if (quota !== null && used + declared > quota) throw overQuota(declared, used, quota);
    if (declared > diskFree) throw diskFull();
  }
  const limit = Math.min(quota === null ? Infinity : quota - used, diskFree);
  const received = await receive(req, limit, (bytes) => (bytes > diskFree ? diskFull() : overQuota(bytes, used, quota)));

  let stored = false;
  try {
    let info;
    try {
      info = await audio.analyse(received.tmp);
    } catch (err) {
      if (err instanceof audio.AudioError) throw refuse(422, 'file_not_usable', err.message);
      throw err;
    }
    const file = { name, ...info };
    if (use) {
      const format = station ? await streamFormat(station.slug) : null;
      const problem = problemFor(file, use, format, await settings.get('ident_max_seconds'));
      if (problem) throw refuse(422, 'file_not_usable', problem);
    }

    // The same file again (uploaded from another station, say) is not stored twice.
    const same = await db.query(`SELECT ${COLUMNS} FROM media_files WHERE user_id = $1 AND sha256 = $2 ORDER BY id LIMIT 1`, [owner.id, received.sha256]);
    if (same.rows[0]) return { ...same.rows[0], already_stored: true };

    const client = await db.pool.connect();
    let row;
    try {
      // The account row is locked so that two uploads at once cannot both fit into the last free space.
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.id]);
      const now = await usedBytes(owner.id, client);
      if (quota !== null && now + received.bytes > quota) throw overQuota(received.bytes, now, quota);
      ({ rows: [row] } = await client.query(
        `INSERT INTO media_files (user_id, name, original_name, size_bytes, codec, sample_rate, channels, bitrate_kbps, constant_bitrate,
                                  duration_seconds, audio_offset, audio_bytes, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${COLUMNS}`,
        [owner.id, name, originalName, received.bytes, info.codec, info.sample_rate, info.channels, info.bitrate_kbps, info.constant_bitrate,
          info.duration_seconds, info.audio_offset, info.audio_bytes, received.sha256]
      ));
      await fs.promises.rename(received.tmp, localPath(row.id));
      stored = true;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (stored) await fs.promises.rm(localPath(row.id), { force: true });
      throw err;
    } finally {
      client.release();
    }
    // Copying to Dropbox happens afterwards, so a slow or failing Dropbox never loses an upload.
    sync().catch((err) => console.error('[files]', err.message));
    return row;
  } finally {
    if (!stored) await fs.promises.rm(received.tmp, { force: true });
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

const fetching = new Map();

// The file's path on this server, fetching it from Dropbox first if its local copy was dropped.
async function ensureLocal(row) {
  const target = localPath(row.id);
  try {
    await fs.promises.access(target);
    // Marks it as recently used, for the cache.
    const now = new Date();
    fs.promises.utimes(target, now, now).catch(() => {});
    return target;
  } catch {
    if (row.storage !== 'dropbox') throw refuse(410, 'file_missing', 'This file is no longer on the server. Upload it again.');
  }
  if (!fetching.has(row.id)) {
    fetching.set(row.id, dropbox.download(row.storage_path, target).finally(() => fetching.delete(row.id)));
  }
  await fetching.get(row.id);
  return target;
}

async function find(id) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM media_files WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Sends the file. `audioOnly` leaves out tags, which is what an engine splices into a stream.
async function send(res, row, { audioOnly = false, download = false } = {}) {
  const file = await ensureLocal(row);
  const start = audioOnly ? row.audio_offset : 0;
  const length = audioOnly ? row.audio_bytes : row.size_bytes;
  res.set({
    'Content-Type': row.codec === 'aac' ? 'audio/aac' : 'audio/mpeg',
    'Content-Length': String(length),
    ETag: `"${row.sha256.slice(0, 16)}"`,
    'Cache-Control': 'private, no-cache',
  });
  if (download) res.attachment(row.original_name || `${row.name}.${row.codec === 'aac' ? 'aac' : 'mp3'}`);
  // Once the headers are out, a failure can only be shown by cutting the response short.
  await pipeline(fs.createReadStream(file, { start, end: start + length - 1 }), res).catch(() => res.destroy());
}

// ── Removal ─────────────────────────────────────────────────────────────────

async function stationsUsing(id) {
  const { rows } = await db.query('SELECT slug FROM stations WHERE ident_file_id = $1 OR fallback_file_id = $1 ORDER BY slug', [id]);
  return rows.map((row) => row.slug);
}

// Removes the stored copies of files whose rows are gone or about to go.
async function discard(rows) {
  for (const row of rows) {
    await fs.promises.rm(localPath(row.id), { force: true });
    if (row.storage === 'dropbox' && row.storage_path) {
      await dropbox.remove(row.storage_path).catch((err) => console.error(`[files] could not delete ${row.storage_path} from Dropbox: ${err.message}`));
    }
  }
}

async function remove(row) {
  await db.query('DELETE FROM media_files WHERE id = $1', [row.id]);
  await discard([row]);
}

// ── Housekeeping ────────────────────────────────────────────────────────────

let syncing = false;

// Copies new files to Dropbox, trims the local cache and clears leftovers.
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    if (await dropbox.connected()) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM media_files WHERE storage = 'local' ORDER BY id`);
      for (const row of rows) {
        const remote = `/${row.user_id}/${row.id}-${(row.original_name || row.name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}`;
        try {
          await dropbox.upload(localPath(row.id), remote, row.size_bytes);
          await db.query("UPDATE media_files SET storage = 'dropbox', storage_path = $1 WHERE id = $2", [remote, row.id]);
        } catch (err) {
          console.error(`[files] "${row.name}" was not copied to Dropbox and stays on this server: ${err.message}`);
          break;
        }
      }
    }
    await trim();
  } finally {
    syncing = false;
  }
}

// Keeps the local copies of files that are also in Dropbox within the cache
// size. Files no station uses go first, then the least recently used.
async function trim() {
  const { rows } = await db.query(
    `SELECT f.id, f.storage,
            EXISTS (SELECT 1 FROM stations s WHERE s.ident_file_id = f.id OR s.fallback_file_id = f.id) AS in_use
     FROM media_files f`
  );
  const known = new Map(rows.map((row) => [String(row.id), row]));
  const cached = [];
  let total = 0;
  for (const entry of await fs.promises.readdir(config.filesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(config.filesDir, entry.name);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) continue;
    const row = known.get(entry.name);
    if (!row) {
      // Not a file the library knows (its row was deleted, or a download that never finished).
      if (Date.now() - stat.mtimeMs > 3600 * 1000) await fs.promises.rm(file, { force: true });
      continue;
    }
    if (row.storage !== 'dropbox') continue;
    cached.push({ file, bytes: stat.size, used: stat.mtimeMs, inUse: row.in_use });
    total += stat.size;
  }
  const cap = config.fileCacheMb * MB;
  cached.sort((a, b) => a.inUse - b.inUse || a.used - b.used);
  for (const entry of cached) {
    if (total <= cap) break;
    await fs.promises.rm(entry.file, { force: true });
    total -= entry.bytes;
  }
}

// Makes this server the only home of every file again, ahead of disconnecting Dropbox.
async function bringHome() {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM media_files WHERE storage = 'dropbox' ORDER BY id`);
  const failed = [];
  let returned = 0;
  for (const row of rows) {
    try {
      await ensureLocal(row);
      await db.query("UPDATE media_files SET storage = 'local', storage_path = NULL WHERE id = $1", [row.id]);
      returned += 1;
    } catch (err) {
      failed.push({ id: row.id, name: row.name, reason: err.message });
    }
  }
  return { returned, failed };
}

function present(row, usedBy) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    original_name: row.original_name,
    size_bytes: row.size_bytes,
    format: describeFile(row),
    codec: row.codec,
    sample_rate: row.sample_rate,
    channels: row.channels,
    bitrate_kbps: row.bitrate_kbps,
    constant_bitrate: row.constant_bitrate,
    duration_seconds: Number(row.duration_seconds),
    stored_in: row.storage,
    used_by: usedBy || [],
    created_at: row.created_at,
  };
}

/**
 * Checks the ident and fallback files a station is being given. `owner` is
 * the account the station belongs to; `slug` is null for a station that does
 * not exist yet. Throws a validation error naming the field and the remedy.
 */
async function checkAssignment(fields, ownerId, slug) {
  if (!fields.ident_file_id && !fields.fallback_file_id) return;
  const errors = [];
  const format = slug ? await streamFormat(slug) : null;
  const identMax = await settings.get('ident_max_seconds');
  for (const [field, use] of [['ident_file_id', 'ident'], ['fallback_file_id', 'fallback']]) {
    if (fields[field] === undefined || fields[field] === null) continue;
    const file = await find(fields[field]);
    if (!file || file.user_id !== ownerId) {
      errors.push({ field, message: "is not a file in this station's account" });
      continue;
    }
    const problem = problemFor(file, use, format, identMax);
    if (problem) errors.push({ field, message: problem });
  }
  if (errors.length) throw invalid(errors);
}

module.exports = {
  COLUMNS, init, create, find, send, remove, discard, sync, usage, quotaBytes, usedBytes, streamFormat, problemFor, checkAssignment,
  stationsUsing, bringHome, present, size,
};
