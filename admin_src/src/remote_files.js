// Idents and fallback audio given by address instead of by upload.
//
// A system that keeps a station's files itself (Airwave OS, for one) sends
// `ident_url` / `fallback_url` with the file's SHA-256. The file is downloaded
// once, checked against the checksum and against the station's stream exactly
// like an upload, and kept in the upload library; the station then uses it as
// its `ident_file_id` / `fallback_file_id`. The same address and checksum again
// do nothing, so the fields can be sent on every update.
//
// Stations that use uploads are not affected: these fields are optional, and
// choosing an uploaded file directly clears the address.

const crypto = require('crypto');
const dns = require('dns');
const { Readable } = require('stream');
const config = require('./config');
const v = require('./validate');
const { HttpError, invalid } = require('./errors');

const USES = ['ident', 'fallback'];
// Larger than any sensible ident or fallback; the account's quota still applies.
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const SHA_RE = /^[0-9a-f]{64}$/;

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const blank = (value) => value === null || value === undefined || value === '';

/**
 * Reads `<use>_url` and `<use>_sha256` from a station payload. Returns only
 * the uses that were given: { ident: { url, sha256 } | { url: null } }.
 */
function parse(body) {
  const out = {};
  const errors = [];
  if (!body || typeof body !== 'object') return out;
  for (const use of USES) {
    const urlKey = `${use}_url`;
    const shaKey = `${use}_sha256`;
    if (!has(body, urlKey)) {
      if (has(body, shaKey)) errors.push({ field: shaKey, message: `is only used together with ${urlKey}` });
      continue;
    }
    if (blank(body[urlKey])) {
      out[use] = { url: null, sha256: null };
      continue;
    }
    const problem = v.checkUrl(body[urlKey]);
    if (problem) errors.push({ field: urlKey, message: problem });
    const sha = typeof body[shaKey] === 'string' ? body[shaKey].toLowerCase() : body[shaKey];
    if (!SHA_RE.test(String(sha || ''))) errors.push({ field: shaKey, message: `must be the file's SHA-256 as 64 hex characters, so that the downloaded file can be checked` });
    if (!problem && SHA_RE.test(String(sha || ''))) out[use] = { url: body[urlKey], sha256: sha };
  }
  if (errors.length) throw invalid(errors);
  return out;
}

// Refuses a host that resolves to a private address, unless private sources are allowed.
async function checkResolved(url) {
  if (config.allowPrivateSources) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error(`its host ${host} could not be found`);
  }
  if (addresses.some((a) => v.isPrivateHost(a.address))) throw new Error('it points to a private network address');
}

/**
 * Downloads a file and checks its checksum. Redirects are refused, so the
 * address that was checked is the one that is read.
 */
async function download(url, sha256, { maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  await checkResolved(url);
  let res;
  try {
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'audio/*' } });
  } catch (err) {
    throw new Error(`it could not be downloaded (${err.cause ? err.cause.message || err.cause.code : err.message})`);
  }
  if (!res.ok) throw new Error(`the address answered ${res.status}`);
  const declared = parseInt(res.headers.get('content-length'), 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`it is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of res.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error(`it is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    hash.update(chunk);
    chunks.push(Buffer.from(chunk));
  }
  const got = hash.digest('hex');
  if (got !== sha256) throw new Error(`the downloaded file's SHA-256 is ${got}, not the ${sha256} that was given`);
  return Buffer.concat(chunks);
}

// What the upload code reads a request body through, for a file already in memory.
function asUpload(buffer) {
  const body = Readable.from([buffer]);
  body.get = (header) => (String(header).toLowerCase() === 'content-length' ? String(buffer.length) : undefined);
  return body;
}

/**
 * Turns the given addresses into file ids on `fields`, downloading what is
 * not already in the owner's library. `current` is the station row when it
 * exists. Choosing a file id directly clears the address for that use.
 */
async function apply(fields, given, { owner, station, current, name }) {
  const media = require('./media');
  const db = require('./db');
  for (const use of USES) {
    const idKey = `${use}_file_id`;
    const spec = given[use];
    if (!spec) {
      // An uploaded file chosen directly: the address no longer describes it.
      if (has(fields, idKey) && current && current[`${use}_url`] && fields[idKey] !== current[idKey]) {
        fields[`${use}_url`] = null;
        fields[`${use}_sha256`] = null;
      }
      continue;
    }
    if (spec.url === null) {
      Object.assign(fields, { [idKey]: null, [`${use}_url`]: null, [`${use}_sha256`]: null });
      continue;
    }
    fields[`${use}_url`] = spec.url;
    fields[`${use}_sha256`] = spec.sha256;
    // A file with this checksum already in the library is used, as long as its
    // content is still here; if its copy has gone, it is fetched again.
    const same = await db.query(`SELECT ${media.COLUMNS} FROM media_files WHERE user_id = $1 AND sha256 = $2 AND status = 'ready' ORDER BY id LIMIT 1`, [owner.id, spec.sha256]);
    if (same.rows[0]) {
      if (!(await media.available(same.rows[0]))) {
        try {
          await media.restoreCopy(same.rows[0], await download(spec.url, spec.sha256));
        } catch (err) {
          throw invalid([{ field: `${use}_url`, message: `cannot be used: the stored copy is missing and ${err.message}` }]);
        }
      }
      if (!(current && current[idKey] === same.rows[0].id)) fields[idKey] = same.rows[0].id;
      continue;
    }
    let buffer;
    try {
      buffer = await download(spec.url, spec.sha256);
    } catch (err) {
      throw invalid([{ field: `${use}_url`, message: `cannot be used: ${err.message}` }]);
    }
    const fileName = `${name || 'Station'} ${use === 'ident' ? 'ident' : 'fallback audio'}`.slice(0, 100);
    const originalName = decodeURIComponent(new URL(spec.url).pathname.split('/').pop() || '') || fileName;
    try {
      const row = await media.create(asUpload(buffer), owner, { name: fileName, originalName: originalName.slice(0, 200), use, station: station || null });
      fields[idKey] = row.id;
    } catch (err) {
      if (err instanceof HttpError && err.code === 'conversion_needed') {
        // Converting needs the owner's agreement, which an address cannot give: the sender has to send the right file.
        throw invalid([{ field: `${use}_url`, message: `is not in this station's stream format. Send a file that is already ${err.details.target}.`, target: err.details.target }]);
      }
      if (err instanceof HttpError && err.status < 500) throw invalid([{ field: `${use}_url`, message: err.message, ...(err.details && !Array.isArray(err.details) ? err.details : {}) }]);
      throw err;
    }
  }
  return fields;
}

module.exports = { USES, MAX_BYTES, parse, download, asUpload, apply, checkResolved };
