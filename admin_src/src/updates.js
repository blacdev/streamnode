// Version monitoring and update control.
//
// The running version is the commit the admin image was built from. The
// latest is the head of the watched branch, read from GitHub's public API.
//
// Installing an update is done on the host by scripts/update.sh, which a
// scheduler runs every few minutes. The dashboard steers it through two small
// files in a directory shared with the host (CONTROL_DIR):
//   update-settings  written here: AUTO, TIME, REQUEST ("install now")
//   update-status    written by the host: what the updater last did
// The service itself never touches Docker or the host.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { redis } = require('./cache');
const { HttpError, invalid } = require('./errors');

const SETTINGS = path.join(config.controlDir, 'update-settings');
const STATUS = path.join(config.controlDir, 'update-status');
const DEFAULTS = { AUTO: 'false', TIME: '04:15', REQUEST: '0' };
const SHA_RE = /^[0-9a-f]{40}$/;
// The scheduler runs every 5 minutes; allow for a slow or busy pass.
const SCHEDULER_STALE_MS = 15 * 60 * 1000;

const state = { latest: null, checked_at: null, error: null };

const enabled = () => Boolean(config.updateRepo);

function readPairs(file) {
  try {
    return Object.fromEntries(
      fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('=')).map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      })
    );
  } catch {
    return {};
  }
}

// Written to a temporary file and renamed, so the host never reads half a file.
function writePairs(file, pairs) {
  const tmp = path.join(config.controlDir, `.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmp, Object.entries(pairs).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o666 });
    fs.chmodSync(tmp, 0o666);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new HttpError(503, 'updater_unavailable', `Update settings cannot be saved on this server (${err.code || err.message}). Run ./install.sh on the server to set the updater up.`);
  }
}

async function check() {
  if (!enabled()) return;
  try {
    const response = await fetch(`https://api.github.com/repos/${config.updateRepo}/commits/${encodeURIComponent(config.updateBranch)}`, {
      headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'radio-gateway' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
    const sha = (await response.text()).trim();
    if (!SHA_RE.test(sha)) throw new Error('unexpected answer from GitHub');
    state.latest = sha;
    state.error = null;
  } catch (err) {
    state.error = err.message;
  }
  state.checked_at = new Date().toISOString();
}

function settings() {
  const saved = { ...DEFAULTS, ...readPairs(SETTINGS) };
  return { auto: saved.AUTO === 'true', time: /^\d\d:\d\d$/.test(saved.TIME) ? saved.TIME : DEFAULTS.TIME };
}

function saveSettings(body) {
  const errors = [];
  if (body.auto !== undefined && typeof body.auto !== 'boolean') errors.push({ field: 'auto', message: 'must be true or false' });
  if (body.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) errors.push({ field: 'time', message: 'must be a time of day as HH:MM, e.g. 04:15' });
  if (errors.length) throw invalid(errors);
  const current = { ...DEFAULTS, ...readPairs(SETTINGS) };
  if (body.auto !== undefined) current.AUTO = String(body.auto);
  if (body.time !== undefined) current.TIME = body.time;
  writePairs(SETTINGS, current);
  return settings();
}

// Asks the host to install the latest version on its next pass (within 5 minutes).
function requestInstall() {
  const current = { ...DEFAULTS, ...readPairs(SETTINGS) };
  current.REQUEST = String(Math.floor(Date.now() / 1000));
  writePairs(SETTINGS, current);
}

function updater() {
  const seen = readPairs(STATUS);
  const tick = seen.TICK ? Date.parse(seen.TICK) : NaN;
  const requested = Number(readPairs(SETTINGS).REQUEST) || 0;
  return {
    // false means nothing will happen by itself: the scheduler is not installed or not running.
    scheduler_running: Number.isFinite(tick) && Date.now() - tick < SCHEDULER_STALE_MS,
    last_seen: seen.TICK || null,
    server_time: seen.SERVER_TIME || null,
    server_zone: seen.SERVER_ZONE || null,
    state: seen.STATE || 'idle',
    message: seen.MESSAGE || null,
    updated_at: seen.UPDATED_AT || null,
    install_pending: requested > (Number(seen.HANDLED_REQUEST) || 0),
  };
}

function status() {
  const installed = SHA_RE.test(config.version) ? config.version : null;
  return {
    enabled: enabled(),
    repository: config.updateRepo || null,
    branch: config.updateBranch,
    installed,
    latest: state.latest,
    // null when it cannot be told: built from source, or GitHub not reachable yet.
    update_available: installed && state.latest ? installed !== state.latest : null,
    checked_at: state.checked_at,
    error: state.error,
    settings: settings(),
    updater: updater(),
  };
}

// Slave nodes follow the version their master runs; engines pass this on.
async function publishVersion() {
  if (SHA_RE.test(config.version)) await redis.hSet('cluster:update', 'master_sha', config.version);
}

module.exports = { check, status, enabled, settings, saveSettings, requestInstall, updater, publishVersion };
