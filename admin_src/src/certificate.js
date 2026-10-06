// The domain's HTTPS certificate: what HAProxy serves, and Let's Encrypt.
//
// The certificate is read from HAProxy's runtime API, so the dashboard shows
// exactly what browsers and players are given. With TLS_MODE=letsencrypt it is
// obtained and renewed on the host by scripts/letsencrypt.sh, which a scheduler
// runs every few minutes. As with updates, the dashboard steers it through two
// small files in the directory shared with the host (CONTROL_DIR):
//   cert-settings  written here: REQUEST ("renew now")
//   cert-status    written by the host: what the script last did
// Let's Encrypt's challenge files are served from ACME_DIR, which certbot fills.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const haproxy = require('./haproxy');
const { readPairs, writePairs } = require('./updates');

const SETTINGS = path.join(config.controlDir, 'cert-settings');
const STATUS = path.join(config.controlDir, 'cert-status');
const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;
const SCHEDULER_STALE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// "Key: value" lines from "show ssl cert"; the first of each key is the
// certificate itself, later ones (Chain Subject...) belong to the chain.
function parseCert(output) {
  const fields = {};
  for (const line of output.split('\n')) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    if (!(key in fields)) fields[key] = line.slice(at + 1).trim();
  }
  if (!fields.notAfter) return null;
  const expires = Date.parse(fields.notAfter);
  const issuer = fields.Issuer || '';
  const subject = fields.Subject || '';
  const names = (fields['Subject Alternative Name'] || '').split(',').map((n) => n.trim().replace(/^(DNS|IP Address):/, '')).filter(Boolean);
  return {
    subject,
    issuer,
    names,
    not_before: Number.isFinite(Date.parse(fields.notBefore)) ? new Date(Date.parse(fields.notBefore)).toISOString() : null,
    expires_at: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
    days_left: Number.isFinite(expires) ? Math.floor((expires - Date.now()) / DAY_MS) : null,
    self_signed: issuer === subject,
    lets_encrypt: /Let's Encrypt|ISRG/i.test(issuer),
  };
}

async function served() {
  if (!haproxy.enabled() || config.tlsMode === 'external') return { certificate: null, error: null };
  try {
    const output = await haproxy.command(`show ssl cert ${config.certFile}`);
    const certificate = parseCert(output);
    return { certificate, error: certificate ? null : output.split('\n')[0] || 'HAProxy did not describe the certificate' };
  } catch (err) {
    return { certificate: null, error: err.message };
  }
}

function renewer() {
  const seen = readPairs(STATUS);
  const tick = seen.TICK ? Date.parse(seen.TICK) : NaN;
  const requested = Number(readPairs(SETTINGS).REQUEST) || 0;
  return {
    // false: nothing obtains or renews the certificate by itself on this server.
    scheduler_running: Number.isFinite(tick) && Date.now() - tick < SCHEDULER_STALE_MS,
    last_seen: seen.TICK || null,
    state: seen.STATE || 'idle',
    message: seen.MESSAGE || null,
    updated_at: seen.UPDATED_AT || null,
    request_pending: requested > (Number(seen.HANDLED_REQUEST) || 0),
  };
}

async function status() {
  const { certificate, error } = await served();
  const domain = config.domain || null;
  const matches = Boolean(certificate && domain && certificate.names.some((n) => n.toLowerCase() === domain.toLowerCase()));
  return {
    mode: config.tlsMode,
    domain,
    certificate,
    error,
    // A certificate browsers accept for the domain, without a warning.
    trusted: Boolean(certificate && !certificate.self_signed && matches && certificate.days_left >= 0),
    lets_encrypt: config.tlsMode === 'letsencrypt' ? renewer() : null,
  };
}

// Asks the host to obtain the certificate, or renew it now, on its next pass.
function requestRenewal() {
  writePairs(SETTINGS, { ...readPairs(SETTINGS), REQUEST: String(Math.floor(Date.now() / 1000)) }, 'The renewal request');
}

// GET /.well-known/acme-challenge/:token, for Let's Encrypt.
function challenge(req, res) {
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) return res.status(404).end();
  fs.readFile(path.join(config.acmeDir, '.well-known', 'acme-challenge', token), (err, data) => {
    if (err) return res.status(404).type('text/plain').send('Not found\n');
    res.type('text/plain').set('Cache-Control', 'no-store').send(data);
  });
}

module.exports = { status, requestRenewal, challenge, parseCert };
