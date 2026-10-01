const net = require('net');
const config = require('./config');
const { invalid } = require('./errors');

// Paths HAProxy and the engine keep for themselves.
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'healthz', 'health', 'metrics', 'status', 'static', 'assets', 'docs', 'favicon', 'robots', 'index',
]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,48}[a-z0-9])?$/;
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{1,49}$/;

function isPrivateIPv4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return (
    lower === '::' || lower === '::1' ||
    /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower) ||
    lower.startsWith('::ffff:') || lower.startsWith('2001:db8:') || lower.startsWith('64:ff9b:')
  );
}

// A first line of defence only: the engine re-checks every address it actually
// connects to, including after DNS resolution and redirects.
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(host)) return isPrivateIPv4(host);
  if (net.isIPv6(host)) return isPrivateIPv6(host);
  return host === 'localhost' || !host.includes('.') || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host);
}

function checkUrl(value) {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length > 500) return 'must be at most 500 characters';
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute URL such as https://example.com/stream';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must use http or https';
  if (url.username || url.password) return 'must not contain credentials';
  if (!config.allowPrivateSources && isPrivateHost(url.hostname)) return 'must point to a public host';
  return null;
}

function checkSlug(value) {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    return 'must be 1-50 characters of a-z, 0-9, "-" or "_", starting and ending with a letter or digit';
  }
  if (RESERVED_SLUGS.has(value)) return 'is reserved';
  return null;
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const blank = (v) => v === null || v === undefined || v === '';

const ADMIN_ONLY = ['user_id', 'max_listeners', 'external_id', 'is_active'];

/**
 * Validates a station payload and returns only the fields that were supplied.
 * `partial` skips the required-field checks (PATCH and upsert-update).
 */
function parseStation(body, { partial = false, isAdmin = false, allowSlug = true } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'must be a JSON object' }]);
  const errors = [];
  const out = {};
  const fail = (field, message) => errors.push({ field, message });

  if (has(body, 'name')) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) fail('name', 'must be 1-100 characters');
    else out.name = body.name.trim();
  } else if (!partial) fail('name', 'is required');

  if (allowSlug && has(body, 'slug')) {
    const problem = checkSlug(body.slug);
    if (problem) fail('slug', problem);
    else out.slug = body.slug;
  } else if (allowSlug && !partial) fail('slug', 'is required');

  if (has(body, 'primary_url')) {
    const problem = blank(body.primary_url) ? 'is required' : checkUrl(body.primary_url);
    if (problem) fail('primary_url', problem);
    else out.primary_url = body.primary_url;
  } else if (!partial) fail('primary_url', 'is required');

  for (const field of ['backup_url', 'metadata_url', 'artwork_url']) {
    if (!has(body, field)) continue;
    if (blank(body[field])) {
      out[field] = null;
      continue;
    }
    const problem = checkUrl(body[field]);
    if (problem) fail(field, problem);
    else out[field] = body[field];
  }

  for (const field of ADMIN_ONLY) {
    if (has(body, field) && !isAdmin) fail(field, 'can only be set by an administrator');
  }
  if (isAdmin) {
    if (has(body, 'user_id')) {
      if (!Number.isInteger(body.user_id) || body.user_id < 1) fail('user_id', 'must be a user id');
      else out.user_id = body.user_id;
    }
    if (has(body, 'max_listeners')) {
      if (!Number.isInteger(body.max_listeners) || body.max_listeners < 0 || body.max_listeners > 10000000) {
        fail('max_listeners', 'must be an integer from 0 (unlimited) to 10000000');
      } else out.max_listeners = body.max_listeners;
    }
    if (has(body, 'external_id')) {
      if (blank(body.external_id)) out.external_id = null;
      else if (typeof body.external_id !== 'string' || body.external_id.length > 100) fail('external_id', 'must be at most 100 characters');
      else out.external_id = body.external_id;
    }
    if (has(body, 'is_active')) {
      if (typeof body.is_active !== 'boolean') fail('is_active', 'must be true or false');
      else out.is_active = body.is_active;
    }
  }

  if (errors.length) throw invalid(errors);
  return out;
}

function parseUser(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'must be a JSON object' }]);
  const errors = [];
  const out = {};
  const fail = (field, message) => errors.push({ field, message });

  if (has(body, 'username')) {
    if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username)) {
      fail('username', 'must be 2-50 characters: letters, digits, ".", "_", "@" or "-"');
    } else out.username = body.username;
  } else if (!partial) fail('username', 'is required');

  if (has(body, 'password') && !blank(body.password)) {
    if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 200) {
      fail('password', 'must be 10-200 characters');
    } else out.password = body.password;
  }
  if (has(body, 'role')) {
    if (body.role !== 'admin' && body.role !== 'tenant') fail('role', 'must be "admin" or "tenant"');
    else out.role = body.role;
  }
  if (has(body, 'external_id')) {
    if (blank(body.external_id)) out.external_id = null;
    else if (typeof body.external_id !== 'string' || body.external_id.length > 100) fail('external_id', 'must be at most 100 characters');
    else out.external_id = body.external_id;
  }
  if (has(body, 'max_stations')) {
    if (!Number.isInteger(body.max_stations) || body.max_stations < 0 || body.max_stations > 100000) {
      fail('max_stations', 'must be an integer from 0 to 100000');
    } else out.max_stations = body.max_stations;
  }
  if (has(body, 'is_active')) {
    if (typeof body.is_active !== 'boolean') fail('is_active', 'must be true or false');
    else out.is_active = body.is_active;
  }

  if (errors.length) throw invalid(errors);
  return out;
}

const NODE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,49}$/;
const NODE_HOST_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,253}[a-zA-Z0-9])?$/;

// A streaming server behind HAProxy. Hosts are operator-supplied and are
// normally private addresses, so no public-address check applies here.
function parseNode(body, { partial = false, builtin = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'must be a JSON object' }]);
  const errors = [];
  const out = {};
  const fail = (field, message) => errors.push({ field, message });

  for (const field of ['name', 'host', 'port', 'mode']) {
    if (builtin && has(body, field)) fail(field, 'cannot be changed on the built-in server');
  }
  if (!builtin && has(body, 'mode')) {
    if (body.mode !== 'proxied' && body.mode !== 'direct') fail('mode', 'must be "proxied" or "direct"');
    else out.mode = body.mode;
  }
  if (!builtin) {
    if (has(body, 'name')) {
      if (typeof body.name !== 'string' || !NODE_NAME_RE.test(body.name.trim())) fail('name', 'must be 1-50 letters, digits, spaces, ".", "_" or "-"');
      else out.name = body.name.trim();
    } else if (!partial) fail('name', 'is required');

    if (has(body, 'host')) {
      if (typeof body.host !== 'string' || !NODE_HOST_RE.test(body.host.trim())) fail('host', 'must be a hostname or IPv4 address, without a scheme or port');
      else out.host = body.host.trim().toLowerCase();
    } else if (!partial) fail('host', 'is required');

    if (has(body, 'port')) {
      if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) fail('port', 'must be an integer from 1 to 65535');
      else out.port = body.port;
    }
  }
  if (has(body, 'weight')) {
    if (!Number.isInteger(body.weight) || body.weight < 1 || body.weight > 256) fail('weight', 'must be an integer from 1 to 256');
    else out.weight = body.weight;
  }
  if (has(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') fail('enabled', 'must be true or false');
    else out.enabled = body.enabled;
  }

  if (errors.length) throw invalid(errors);
  return out;
}

function intParam(value, { name, min, max, fallback }) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid([{ field: name, message: `must be an integer from ${min} to ${max}` }]);
  return n;
}

function timeParam(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const date = new Date(/^\d+$/.test(value) ? Number(value) * 1000 : value);
  if (Number.isNaN(date.getTime())) throw invalid([{ field: name, message: 'must be an ISO 8601 timestamp or Unix seconds' }]);
  return date;
}

function dateParam(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid([{ field: name, message: 'must be a date in YYYY-MM-DD form' }]);
  }
  return value;
}

module.exports = { parseStation, parseUser, parseNode, checkSlug, checkUrl, isPrivateHost, intParam, timeParam, dateParam, RESERVED_SLUGS };
