// The upload library: station idents, the files played when a station's
// streams have no audio, and station images.
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
const convert = require('./convert');
const image = require('./image');
const dropbox = require('./dropbox');
const settings = require('./settings');
const stations = require('./stations');
const { HttpError, invalid } = require('./errors');

const MB = 1024 * 1024;
const COLUMNS =
  'id, user_id, name, original_name, size_bytes, codec, sample_rate, channels, bitrate_kbps, constant_bitrate, duration_seconds, audio_offset, audio_bytes, sha256, storage, storage_path, created_at, status, status_detail, converted, gain_db, target_level_db, replaces_id, for_station_id, kind, width, height';
// Disk space that uploads never eat into.
const DISK_RESERVE = 512 * MB;

const localPath = (id) => path.join(config.filesDir, String(id));
// What was uploaded, kept only until its conversion is done.
const sourcePath = (id) => path.join(config.filesDir, `src-${id}`);
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
  // Conversions that were under way when the service stopped are taken up again.
  const { rows } = await db.query("SELECT id FROM media_files WHERE status = 'converting' ORDER BY id");
  for (const row of rows) enqueue(row.id);
}

// ── Quotas ──────────────────────────────────────────────────────────────────

// Bytes an account may hold. Administrators are not limited.
async function quotaBytes(user) {
  if (user.role === 'admin') return null;
  const mb = user.storage_quota_mb === null || user.storage_quota_mb === undefined ? await settings.get('default_storage_quota_mb') : user.storage_quota_mb;
  return mb * MB;
}

// The most an account may store. Normally its quota; with pay as you go for
// storage, its ceiling instead, or no limit when there is none.
async function capBytes(user) {
  const quota = await quotaBytes(user);
  if (quota === null) return null;
  const { rows } = await db.query('SELECT storage_overage, storage_ceiling_mb FROM users WHERE id = $1', [user.id]);
  if (!rows[0] || !rows[0].storage_overage) return quota;
  return rows[0].storage_ceiling_mb === null ? null : Math.max(quota, rows[0].storage_ceiling_mb * MB);
}

async function usedBytes(userId, client = db) {
  const { rows } = await client.query('SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used FROM media_files WHERE user_id = $1', [userId]);
  return rows[0].used;
}

async function usage(user) {
  const [quota, cap, used] = await Promise.all([quotaBytes(user), capBytes(user), usedBytes(user.id)]);
  if (cap !== quota) {
    // Pay as you go: there is room beyond the quota, and what is used beyond it is charged.
    return { used_bytes: used, quota_bytes: quota, free_bytes: cap === null ? null : Math.max(0, cap - used), limit_bytes: cap, over_quota_bytes: Math.max(0, used - quota), pay_as_you_go: true };
  }
  return { used_bytes: used, quota_bytes: quota, free_bytes: quota === null ? null : Math.max(0, quota - used), limit_bytes: quota, over_quota_bytes: 0, pay_as_you_go: false };
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

const describeFile = (row) => (row.kind === 'image' ? image.describe(row) : audio.describe(row));

// What an engine last saw the station's stream to be (format:<slug>).
const streamFormat = async (slug) => stations.streamFormat(await redis.hGetAll(`format:${slug}`));

/**
 * Why a file cannot be used on a station, as a sentence that also says what
 * to do; null when it can. `format` is the station's stream format, or null
 * while it is not known (the station has never been on air).
 */
function problemFor(file, use, format, identMaxSeconds) {
  if (file.kind === 'image') return `"${file.name}" is an image, and ${use === 'ident' ? 'an ident' : 'fallback audio'} has to be an audio file.`;
  if (use === 'ident' && Number(file.duration_seconds) > identMaxSeconds) {
    return `"${file.name}" is ${Number(file.duration_seconds).toFixed(1)} seconds long and an ident may be at most ${identMaxSeconds} seconds. Shorten it and upload it again.`;
  }
  if (file.status === 'failed') {
    return `"${file.name}" could not be converted (${file.status_detail || 'unknown reason'}), so it cannot be used. Delete it and upload it again.`;
  }
  if (!format) return null;
  if (!format.codec) {
    return `"${file.name}" cannot be used on this station: its stream is ${format.content_type || 'in a format'} that the gateway relays as it is, and idents and fallback audio work only on MP3 and AAC streams.`;
  }
  const problems = audio.mismatches(file, format);
  if (!problems.length) return null;
  return `"${file.name}" cannot be played on this station as it is, because ${problems.join(', and ')}. ${canConvert(format) ? offer(format) : `Export it as ${audio.target(format)} and upload it again.`}`;
}

// Whether the gateway can make audio in this stream's format. HE-AAC it cannot:
// no encoder for it may be distributed with the gateway.
const canConvert = (format) => Boolean(format && format.codec && format.type !== 'he-aac');

// What is said when a file is not in the stream's format and converting it has not been agreed to.
const offer = (format) =>
  `It is best to upload a file that is already ${audio.target(format)}: such a file is used exactly as it is. Or the gateway can convert this one: it is re-encoded to the stream's format, its loudness is matched to the stream, and the converted file takes the place of this one. Converting needs your agreement.`;

// Whether a file's format differs from a stream's in a way that needs converting.
const differs = (file, format) => Boolean(format && format.codec && audio.mismatches(file, format).length);

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
 * `use` ('ident' | 'fallback' | 'artwork') and `station` (a row) are
 * optional: with them the file is also checked for that use on that station
 * before it is kept. A picture is recognised by its content and kept as an
 * image; everything else is treated as audio.
 */
async function create(req, owner, { name, originalName, use, station, consent = false }) {
  const quota = await capBytes(owner);
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
    const picture = await image.inspectFile(received.tmp, received.bytes);
    if (picture) {
      if (use && use !== 'artwork') throw refuse(422, 'file_not_usable', `"${name}" is an image, and ${use === 'ident' ? 'an ident' : 'fallback audio'} has to be an audio file.`);
      if (received.bytes > image.MAX_BYTES) {
        throw refuse(413, 'image_too_large', `"${name}" is ${size(received.bytes)} and a station image may be at most ${size(image.MAX_BYTES)}. Save it smaller (a square of 500 to 1500 pixels is plenty) and upload it again.`);
      }
      const row = await insertReady(owner, quota, received, {
        name, originalName, kind: 'image', codec: picture.type, width: picture.width, height: picture.height, audio_bytes: received.bytes,
      });
      stored = !row.already_stored;
      return row;
    }
    if (use === 'artwork') throw refuse(422, 'file_not_usable', `"${name}" is not a ${image.ACCEPTED} image, which is what a station image has to be.`);

    // MP3 and AAC are read directly. Anything else can only be used by converting it.
    let info = null;
    let unreadable = null;
    try {
      info = await audio.analyse(received.tmp);
    } catch (err) {
      if (!(err instanceof audio.AudioError)) throw err;
      unreadable = err.message;
    }
    const format = station ? await streamFormat(station.slug) : null;
    const identMax = await settings.get('ident_max_seconds');

    if (!info || differs(info, format)) {
      if (!canConvert(format)) {
        // No station to convert it for, or a stream whose format cannot be produced here.
        if (info) throw refuse(422, 'file_not_usable', problemFor({ name, ...info }, use || 'fallback', format, identMax));
        throw refuse(422, 'file_not_usable', station
          ? unreadable
          : `${unreadable} Other formats can be converted when the file is uploaded for a particular station, once that station has been on air.`);
      }
      if (!consent) {
        const what = info ? `"${name}" is ${audio.describe(info)} and this station's stream is ${format.summary}.` : `"${name}" is not in this station's format (${format.summary}).`;
        throw refuse(422, 'conversion_needed', `${what} ${offer(format)} Tick the box to agree and upload it again (API: convert=true).`, { can_convert: true, target: audio.target(format) });
      }
      if (!(await convert.available())) throw refuse(501, 'conversion_unavailable', 'This server cannot convert audio (ffmpeg is not installed). Upload the file in the stream\'s format.');
      let probed;
      try {
        probed = await convert.probe(received.tmp);
      } catch (err) {
        if (err instanceof convert.ConvertError) throw refuse(422, 'file_not_usable', err.message);
        throw err;
      }
      if (use === 'ident' && probed.duration_seconds > identMax) {
        throw refuse(422, 'file_not_usable', `"${name}" is ${probed.duration_seconds.toFixed(1)} seconds long and an ident may be at most ${identMax} seconds. Shorten it and upload it again.`);
      }
      const row = await insertConverting(owner, quota, {
        name, originalName, size: received.bytes, sha256: received.sha256, duration: probed.duration_seconds || 0, format, station,
      });
      await fs.promises.rename(received.tmp, sourcePath(row.id));
      stored = true;
      enqueue(row.id);
      return row;
    }

    if (use) {
      const problem = problemFor({ name, ...info }, use, format, identMax);
      if (problem) throw refuse(422, 'file_not_usable', problem);
    }

    const row = await insertReady(owner, quota, received, { name, originalName, kind: 'audio', ...info });
    stored = !row.already_stored;
    return row;
  } finally {
    if (!stored) await fs.promises.rm(received.tmp, { force: true });
  }
}

// Keeps a received file that needs nothing more done to it, and returns its row.
async function insertReady(owner, quota, received, file) {
  // The same file again (uploaded from another station, say) is not stored twice.
  const same = await db.query(`SELECT ${COLUMNS} FROM media_files WHERE user_id = $1 AND sha256 = $2 ORDER BY id LIMIT 1`, [owner.id, received.sha256]);
  if (same.rows[0]) return { ...same.rows[0], already_stored: true };

  const client = await db.pool.connect();
  let row;
  let moved = false;
  try {
    // The account row is locked so that two uploads at once cannot both fit into the last free space.
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.id]);
    const now = await usedBytes(owner.id, client);
    if (quota !== null && now + received.bytes > quota) throw overQuota(received.bytes, now, quota);
    ({ rows: [row] } = await client.query(
      `INSERT INTO media_files (user_id, name, original_name, size_bytes, codec, sample_rate, channels, bitrate_kbps, constant_bitrate,
                                duration_seconds, audio_offset, audio_bytes, sha256, kind, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING ${COLUMNS}`,
      [owner.id, file.name, file.originalName, received.bytes, file.codec, file.sample_rate || 0, file.channels || 0, file.bitrate_kbps || 0, Boolean(file.constant_bitrate),
        file.duration_seconds || 0, file.audio_offset || 0, file.audio_bytes || 0, received.sha256, file.kind, file.width || null, file.height || null]
    ));
    await fs.promises.rename(received.tmp, localPath(row.id));
    moved = true;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (moved) await fs.promises.rm(localPath(row.id), { force: true });
    throw err;
  } finally {
    client.release();
  }
  // Copying to Dropbox happens afterwards, so a slow or failing Dropbox never loses an upload.
  sync().catch((err) => console.error('[files]', err.message));
  return row;
}

// ── Conversion ──────────────────────────────────────────────────────────────

// Records a file whose audio is still to be converted. It is described as what
// it will become, so that it can be chosen for its station straight away.
async function insertConverting(owner, quota, { name, originalName, size: bytes, sha256, duration, format, station, replaces = null }) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.id]);
    const now = await usedBytes(owner.id, client);
    if (quota !== null && now + bytes > quota) throw overQuota(bytes, now, quota);
    const { rows } = await client.query(
      `INSERT INTO media_files (user_id, name, original_name, size_bytes, codec, sample_rate, channels, bitrate_kbps, constant_bitrate,
                                duration_seconds, audio_offset, audio_bytes, sha256, status, converted, target_level_db, replaces_id, for_station_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0, $11, 'converting', true, $12, $13, $14) RETURNING ${COLUMNS}`,
      [owner.id, name, originalName, bytes, format.codec, format.sample_rate, format.channels,
        format.bitrate_kbps || (format.codec === 'mp3' ? 128 : 96), format.codec === 'mp3', duration, sha256,
        Number.isFinite(format.level_db) ? format.level_db : null, replaces, station ? station.id : null]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Converts a file that is already in the library for a station whose stream
 * it does not match. The original stays as it is until the conversion has
 * succeeded; then the converted file takes its place on that station, and the
 * original is removed if no other station uses it.
 */
async function convertExisting(file, owner, station, use) {
  if (file.kind === 'image') throw refuse(422, 'file_not_usable', 'This is an image. Only audio is converted.');
  const format = await streamFormat(station.slug);
  if (file.status !== 'ready') throw refuse(409, 'file_not_ready', 'This file is still being converted, or its conversion failed.');
  if (!differs(file, format)) throw refuse(409, 'conversion_not_needed', 'This file is already in the station\'s format.');
  if (!canConvert(format)) throw refuse(422, 'file_not_usable', problemFor(file, use, format, Infinity));
  if (!(await convert.available())) throw refuse(501, 'conversion_unavailable', 'This server cannot convert audio (ffmpeg is not installed).');
  const identMax = await settings.get('ident_max_seconds');
  if (use === 'ident' && Number(file.duration_seconds) > identMax) throw refuse(422, 'file_not_usable', problemFor(file, use, null, identMax));
  const source = await ensureLocal(file);
  // It takes no space of its own while it is converted: the original is counted, and usually makes way for it.
  const row = await insertConverting(owner, null, {
    name: file.name, originalName: file.original_name, size: 0, sha256: file.sha256, duration: Number(file.duration_seconds), format, station, replaces: file.id,
  });
  await fs.promises.copyFile(source, sourcePath(row.id));
  enqueue(row.id);
  return row;
}

const waiting = [];
let working = false;

// Conversions run one at a time, so that they never take more than one processor core.
function enqueue(id) {
  waiting.push(id);
  if (working) return;
  working = true;
  (async () => {
    while (waiting.length) {
      const next = waiting.shift();
      await finish(next).catch((err) => console.error(`[files] conversion of file ${next} failed:`, err.message));
    }
    working = false;
  })();
}

async function finish(id) {
  const row = await find(id);
  if (!row || row.status !== 'converting') return;
  const source = sourcePath(id);
  const output = path.join(tmpDir(), `converted-${id}`);
  const fail = async (detail) => {
    await db.query("UPDATE media_files SET status = 'failed', status_detail = $1, size_bytes = 0 WHERE id = $2", [String(detail).slice(0, 300), id]);
    await fs.promises.rm(source, { force: true });
    await fs.promises.rm(output, { force: true });
    await stations.republishUser(row.user_id);
  };
  try {
    await fs.promises.access(source);
  } catch {
    return fail('the upload was lost before it could be converted');
  }
  const target = { codec: row.codec, sample_rate: row.sample_rate, channels: row.channels, bitrate_kbps: row.bitrate_kbps };
  let info;
  let gain;
  try {
    const before = await convert.level(source, target);
    gain = convert.gainFor(before.mean_db, row.target_level_db === null ? NaN : Number(row.target_level_db));
    await convert.convert(source, output, target, gain);
    info = await audio.analyse(output);
  } catch (err) {
    if (err instanceof convert.ConvertError || err instanceof audio.AudioError) return fail(err.message);
    throw err;
  }
  const bytes = (await fs.promises.stat(output)).size;
  const sha256 = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(output).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });

  // Does the file it was made from now make way for it? Only if no other station uses that file.
  const original = row.replaces_id ? await find(row.replaces_id) : null;
  const elsewhere = original ? await db.query(
    'SELECT 1 FROM stations WHERE (ident_file_id = $1 OR fallback_file_id = $1) AND id IS DISTINCT FROM $2 LIMIT 1', [original.id, row.for_station_id]
  ) : null;
  const dropOriginal = Boolean(original && elsewhere.rowCount === 0);

  const { rows: [owner] } = await db.query('SELECT id, role, storage_quota_mb FROM users WHERE id = $1', [row.user_id]);
  const quota = await capBytes(owner);
  const used = (await usedBytes(row.user_id)) - row.size_bytes - (dropOriginal ? original.size_bytes : 0);
  if (quota !== null && used + bytes > quota) {
    return fail(`the converted file (${size(bytes)}) does not fit in the account's remaining storage`);
  }
  await fs.promises.rename(output, localPath(id));
  if (original && row.for_station_id) {
    for (const column of ['ident_file_id', 'fallback_file_id']) {
      await db.query(`UPDATE stations SET ${column} = $1, updated_at = now() WHERE id = $2 AND ${column} = $3`, [id, row.for_station_id, original.id]);
    }
  }
  await db.query(
    `UPDATE media_files SET status = 'ready', status_detail = NULL, size_bytes = $1, codec = $2, sample_rate = $3, channels = $4, bitrate_kbps = $5,
            constant_bitrate = $6, duration_seconds = $7, audio_offset = $8, audio_bytes = $9, sha256 = $10, gain_db = $11 WHERE id = $12`,
    [bytes, info.codec, info.sample_rate, info.channels, info.bitrate_kbps, info.constant_bitrate, info.duration_seconds, info.audio_offset, info.audio_bytes, sha256, gain, id]
  );
  await fs.promises.rm(source, { force: true });
  if (dropOriginal) await remove(original);
  await stations.republishUser(row.user_id);
  sync().catch((err) => console.error('[files]', err.message));
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
// `open` is for a station's image, which anyone may fetch and keep: `open.versioned` says
// the address names this exact content, so it never has to be asked for again.
async function send(res, row, { audioOnly = false, download = false, open = null } = {}) {
  if (row.status !== 'ready') {
    throw refuse(409, 'file_not_ready', row.status === 'converting' ? 'This file is still being converted.' : 'This file could not be converted and has no audio.');
  }
  const file = await ensureLocal(row);
  const start = audioOnly ? row.audio_offset : 0;
  const length = audioOnly ? row.audio_bytes : row.size_bytes;
  const isImage = row.kind === 'image';
  const etag = `"${row.sha256.slice(0, 16)}"`;
  res.set({
    'Content-Type': isImage ? image.TYPES[row.codec] : row.codec === 'aac' ? 'audio/aac' : 'audio/mpeg',
    ETag: etag,
    'Cache-Control': open ? (open.versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300') : 'private, no-cache',
    // A file is only ever what it was checked to be.
    'X-Content-Type-Options': 'nosniff',
  });
  if (open && res.req.get('if-none-match') === etag) return res.status(304).end();
  res.set('Content-Length', String(length));
  if (download) res.attachment(row.original_name || `${row.name}.${isImage ? image.EXTENSIONS[row.codec] : row.codec === 'aac' ? 'aac' : 'mp3'}`);
  // Once the headers are out, a failure can only be shown by cutting the response short.
  await pipeline(fs.createReadStream(file, { start, end: start + length - 1 }), res).catch(() => res.destroy());
}

// ── Removal ─────────────────────────────────────────────────────────────────

async function stationsUsing(id) {
  const { rows } = await db.query('SELECT slug FROM stations WHERE ident_file_id = $1 OR fallback_file_id = $1 OR artwork_file_id = $1 ORDER BY slug', [id]);
  return rows.map((row) => row.slug);
}

// Removes the stored copies of files whose rows are gone or about to go.
async function discard(rows) {
  for (const row of rows) {
    await fs.promises.rm(localPath(row.id), { force: true });
    await fs.promises.rm(sourcePath(row.id), { force: true });
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
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM media_files WHERE storage = 'local' AND status = 'ready' ORDER BY id`);
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
            EXISTS (SELECT 1 FROM stations s WHERE s.ident_file_id = f.id OR s.fallback_file_id = f.id OR s.artwork_file_id = f.id) AS in_use
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
    // An upload waiting to be converted belongs to its row.
    if (entry.name.startsWith('src-') && known.has(entry.name.slice(4))) continue;
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
    kind: row.kind,
    format: describeFile(row),
    width: row.width,
    height: row.height,
    codec: row.codec,
    sample_rate: row.sample_rate,
    channels: row.channels,
    bitrate_kbps: row.bitrate_kbps,
    constant_bitrate: row.constant_bitrate,
    duration_seconds: Number(row.duration_seconds),
    stored_in: row.storage,
    status: row.status,
    status_detail: row.status_detail,
    converted: row.converted,
    gain_db: row.gain_db === null ? null : Number(row.gain_db),
    used_by: usedBy || [],
    created_at: row.created_at,
  };
}

/**
 * Checks the ident, fallback and image files a station is being given. `owner` is
 * the account the station belongs to; `slug` is null for a station that does
 * not exist yet. Throws a validation error naming the field and the remedy.
 */
async function checkAssignment(fields, ownerId, slug) {
  if (!fields.ident_file_id && !fields.fallback_file_id && !fields.artwork_file_id) return;
  const errors = [];
  if (fields.artwork_file_id) {
    const file = await find(fields.artwork_file_id);
    if (!file || file.user_id !== ownerId) errors.push({ field: 'artwork_file_id', message: "is not a file in this station's account" });
    else if (file.kind !== 'image') errors.push({ field: 'artwork_file_id', message: `"${file.name}" is an audio file. A station image has to be a ${image.ACCEPTED} image.` });
  }
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
    // Saying that it can be converted lets the caller offer that, with the file to convert.
    if (problem) errors.push({ field, message: problem, ...(file.status === 'ready' && differs(file, format) && canConvert(format) ? { can_convert: true, file_id: file.id } : {}) });
  }
  if (errors.length) throw invalid(errors);
}

module.exports = {
  COLUMNS, init, create, convertExisting, capBytes, find, send, remove, discard, sync, usage, quotaBytes, usedBytes, streamFormat, problemFor, checkAssignment,
  stationsUsing, bringHome, present, size,
};
