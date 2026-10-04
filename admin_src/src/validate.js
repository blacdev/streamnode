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

const ADMIN_ONLY = ['user_id', 'max_listeners', 'external_id', 'is_active', 'billing_bitrate_kbps', 'discount_percent', 'price_override', 'subscription_ends_on', 'overage_mode', 'listener_ceiling', 'plan_type', 'bandwidth_gb'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const isPercent = (value) => typeof value === 'number' && value >= 0 && value <= 100;

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

  if (has(body, 'failover_delay_secs')) {
    if (!Number.isInteger(body.failover_delay_secs) || body.failover_delay_secs < 1 || body.failover_delay_secs > 300) {
      fail('failover_delay_secs', 'must be an integer from 1 to 300');
    } else out.failover_delay_secs = body.failover_delay_secs;
  }
  if (has(body, 'silence_detection')) {
    if (typeof body.silence_detection !== 'boolean') fail('silence_detection', 'must be true or false');
    else out.silence_detection = body.silence_detection;
  }
  if (has(body, 'noise_detection')) {
    if (typeof body.noise_detection !== 'boolean') fail('noise_detection', 'must be true or false');
    else out.noise_detection = body.noise_detection;
  }
  if (has(body, 'silence_threshold_db')) {
    if (blank(body.silence_threshold_db)) out.silence_threshold_db = null;
    else if (!Number.isInteger(body.silence_threshold_db) || body.silence_threshold_db < -90 || body.silence_threshold_db > -10) fail('silence_threshold_db', 'must be an integer from -90 to -10, or null for the server\'s setting');
    else out.silence_threshold_db = body.silence_threshold_db;
  }
  // Whether the files exist, belong to the account and fit the stream is checked by the caller.
  for (const field of ['ident_file_id', 'fallback_file_id']) {
    if (!has(body, field)) continue;
    if (blank(body[field])) out[field] = null;
    else if (!Number.isInteger(body[field]) || body[field] < 1) fail(field, 'must be the id of an uploaded file, or null');
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
    // What the station is charged for.
    if (has(body, 'billing_bitrate_kbps')) {
      if (blank(body.billing_bitrate_kbps)) out.billing_bitrate_kbps = null;
      else if (!Number.isInteger(body.billing_bitrate_kbps) || body.billing_bitrate_kbps < 8 || body.billing_bitrate_kbps > 2000) fail('billing_bitrate_kbps', 'must be an integer from 8 to 2000, or null to use the stream\'s own bitrate');
      else out.billing_bitrate_kbps = body.billing_bitrate_kbps;
    }
    if (has(body, 'discount_percent')) {
      if (!isPercent(body.discount_percent)) fail('discount_percent', 'must be a number from 0 to 100');
      else out.discount_percent = body.discount_percent;
    }
    if (has(body, 'price_override')) {
      if (blank(body.price_override)) out.price_override = null;
      else if (typeof body.price_override !== 'number' || body.price_override < 0 || body.price_override > 1e9) fail('price_override', 'must be a number of 0 or more, or null for the calculated price');
      else out.price_override = body.price_override;
    }
    if (has(body, 'plan_type')) {
      if (body.plan_type !== 'listeners' && body.plan_type !== 'bandwidth') fail('plan_type', 'must be "listeners" or "bandwidth"');
      else out.plan_type = body.plan_type;
    }
    if (has(body, 'bandwidth_gb')) {
      if (blank(body.bandwidth_gb)) out.bandwidth_gb = null;
      else if (typeof body.bandwidth_gb !== 'number' || !(body.bandwidth_gb > 0) || body.bandwidth_gb > 1e9) fail('bandwidth_gb', 'must be a number of gigabytes above 0, or null');
      else out.bandwidth_gb = body.bandwidth_gb;
    }
    if (has(body, 'overage_mode')) {
      if (body.overage_mode !== 'capped' && body.overage_mode !== 'pay_as_you_go') fail('overage_mode', 'must be "capped" or "pay_as_you_go"');
      else out.overage_mode = body.overage_mode;
    }
    if (has(body, 'listener_ceiling')) {
      if (blank(body.listener_ceiling)) out.listener_ceiling = null;
      else if (!Number.isInteger(body.listener_ceiling) || body.listener_ceiling < 1 || body.listener_ceiling > 10000000) fail('listener_ceiling', 'must be an integer from 1 to 10000000, or null for no ceiling');
      else out.listener_ceiling = body.listener_ceiling;
    }
    if (has(body, 'subscription_ends_on')) {
      if (blank(body.subscription_ends_on)) out.subscription_ends_on = null;
      else if (typeof body.subscription_ends_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.subscription_ends_on) || Number.isNaN(Date.parse(`${body.subscription_ends_on}T00:00:00Z`))) fail('subscription_ends_on', 'must be a date in YYYY-MM-DD form, or null for no end');
      else out.subscription_ends_on = body.subscription_ends_on;
    }
  }

  if (errors.length) throw invalid(errors);
  return out;
}

// Empty clears the address; otherwise it has to look like one.
function checkEmail(value) {
  if (blank(value)) return null;
  if (typeof value !== 'string' || value.length > 254 || !EMAIL_RE.test(value.trim())) return 'must be an email address, or empty';
  return null;
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
  if (has(body, 'email')) {
    const problem = checkEmail(body.email);
    if (problem) fail('email', problem);
    else out.email = blank(body.email) ? null : body.email.trim();
  }
  if (has(body, 'discount_percent')) {
    if (!isPercent(body.discount_percent)) fail('discount_percent', 'must be a number from 0 to 100');
    else out.discount_percent = body.discount_percent;
  }
  if (has(body, 'storage_overage')) {
    if (typeof body.storage_overage !== 'boolean') fail('storage_overage', 'must be true or false');
    else out.storage_overage = body.storage_overage;
  }
  if (has(body, 'storage_ceiling_mb')) {
    if (blank(body.storage_ceiling_mb)) out.storage_ceiling_mb = null;
    else if (!Number.isInteger(body.storage_ceiling_mb) || body.storage_ceiling_mb < 1 || body.storage_ceiling_mb > 10000000) fail('storage_ceiling_mb', 'must be an integer from 1 to 10000000 (megabytes), or null for no ceiling');
    else out.storage_ceiling_mb = body.storage_ceiling_mb;
  }
  if (has(body, 'storage_quota_mb')) {
    // null returns the account to the gateway's default quota.
    if (body.storage_quota_mb === null) out.storage_quota_mb = null;
    else if (!Number.isInteger(body.storage_quota_mb) || body.storage_quota_mb < 0 || body.storage_quota_mb > 10000000) {
      fail('storage_quota_mb', 'must be an integer from 0 to 10000000 (megabytes), or null for the default');
    } else out.storage_quota_mb = body.storage_quota_mb;
  }

  if (errors.length) throw invalid(errors);
  return out;
}

// Gateway-wide settings an administrator may change.
function parseSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'must be a JSON object' }]);
  const errors = [];
  const out = {};
  const fail = (field, message) => errors.push({ field, message });
  if (has(body, 'ident_max_seconds')) {
    if (!Number.isInteger(body.ident_max_seconds) || body.ident_max_seconds < 1 || body.ident_max_seconds > 30) fail('ident_max_seconds', 'must be an integer from 1 to 30');
    else out.ident_max_seconds = body.ident_max_seconds;
  }
  if (has(body, 'default_storage_quota_mb')) {
    if (!Number.isInteger(body.default_storage_quota_mb) || body.default_storage_quota_mb < 0 || body.default_storage_quota_mb > 10000000) {
      fail('default_storage_quota_mb', 'must be an integer from 0 to 10000000 (megabytes)');
    } else out.default_storage_quota_mb = body.default_storage_quota_mb;
  }
  // The machine the master runs on, when no engine beside it reports its size.
  for (const [field, min, max] of [['master_port_mbps', 1, 400000], ['master_vcpus', 1, 1024], ['master_memory_gb', 1, 16384]]) {
    if (!has(body, field)) continue;
    if (!Number.isInteger(body[field]) || body[field] < min || body[field] > max) fail(field, `must be an integer from ${min} to ${max}`);
    else out[field] = body[field];
  }
  // How often, and whether, notices go out by themselves.
  if (has(body, 'notices')) {
    const notices = body.notices;
    const part = {};
    if (!notices || typeof notices !== 'object' || Array.isArray(notices)) fail('notices', 'must be an object');
    else {
      if (has(notices, 'automatic')) {
        if (typeof notices.automatic !== 'boolean') fail('notices.automatic', 'must be true or false');
        else part.automatic = notices.automatic;
      }
      if (has(notices, 'levels')) {
        const ok = Array.isArray(notices.levels) && notices.levels.length <= 10 && notices.levels.every((level) => Number.isInteger(level) && level >= 1 && level <= 100);
        if (!ok) fail('notices.levels', 'must be a list of up to 10 whole percentages from 1 to 100, such as [50, 75, 90, 100]');
        else part.levels = [...new Set(notices.levels)].sort((a, b) => a - b);
      }
      if (has(notices, 'min_days_between')) {
        if (!Number.isInteger(notices.min_days_between) || notices.min_days_between < 0 || notices.min_days_between > 365) fail('notices.min_days_between', 'must be an integer from 0 to 365');
        else part.min_days_between = notices.min_days_between;
      }
      out.notices = part;
    }
  }
  if (has(body, 'smtp')) {
    const smtp = body.smtp;
    const part = {};
    if (!smtp || typeof smtp !== 'object' || Array.isArray(smtp)) fail('smtp', 'must be an object');
    else {
      for (const field of ['host', 'user', 'password']) {
        if (!has(smtp, field)) continue;
        if (blank(smtp[field])) part[field] = '';
        else if (typeof smtp[field] !== 'string' || smtp[field].length > 255 || /[\r\n]/.test(smtp[field])) fail(`smtp.${field}`, 'must be text of at most 255 characters');
        else part[field] = field === 'password' ? smtp[field] : smtp[field].trim();
      }
      if (has(smtp, 'port')) {
        if (!Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535) fail('smtp.port', 'must be an integer from 1 to 65535');
        else part.port = smtp.port;
      }
      if (has(smtp, 'security')) {
        if (!['starttls', 'tls', 'none'].includes(smtp.security)) fail('smtp.security', 'must be "starttls", "tls" or "none"');
        else part.security = smtp.security;
      }
      for (const field of ['from', 'copy_to']) {
        if (!has(smtp, field)) continue;
        // The sender may be written as: Name <address>.
        const address = typeof smtp[field] === 'string' ? (/<([^>]+)>\s*$/.exec(smtp[field]) || [null, smtp[field]])[1] : smtp[field];
        const problem = checkEmail(address) || (typeof smtp[field] === 'string' && /[\r\n]/.test(smtp[field]) ? 'must be one line' : null);
        if (problem) fail(`smtp.${field}`, problem);
        else part[field] = blank(smtp[field]) ? '' : smtp[field].trim();
      }
      out.smtp = part;
    }
  }
  for (const field of ['dropbox_app_key', 'dropbox_app_secret']) {
    if (!has(body, field)) continue;
    if (blank(body[field])) out[field] = null;
    else if (typeof body[field] !== 'string' || !/^[A-Za-z0-9_-]{6,100}$/.test(body[field].trim())) fail(field, 'does not look like a Dropbox app key or secret');
    else out[field] = body[field].trim();
  }
  if (errors.length) throw invalid(errors);
  return out;
}

// The rate card prices are worked out from.
function parseRates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'must be a JSON object' }]);
  const errors = [];
  const out = {};
  const number = (field, min, max, whole = false) => {
    if (!has(body, field)) return;
    const value = body[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
      errors.push({ field, message: `must be ${whole ? 'an integer' : 'a number'} from ${min} to ${max}` });
    } else out[field] = value;
  };
  if (has(body, 'currency')) {
    if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency)) errors.push({ field: 'currency', message: 'must be a three-letter currency code such as USD' });
    else out.currency = body.currency.toUpperCase();
  }
  number('server_monthly_cost', 0, 1e9);
  number('server_vcpus', 1, 1024, true);
  number('server_memory_gb', 1, 16384, true);
  number('server_port_mbps', 1, 400000, true);
  number('margin_percent', 0, 10000);
  number('storage_price_per_gb', 0, 1e6);
  number('payg_block_listeners', 1, 100000, true);
  number('payg_block_minutes', 1, 1440, true);
  number('payg_price_per_block', 0, 1e6);
  number('payg_storage_price_per_gb', 0, 1e6);
  number('bandwidth_price_per_gb', 0, 1e6);
  number('payg_bandwidth_price_per_gb', 0, 1e6);
  if (errors.length) throw invalid(errors);
  return out;
}

// The server someone is thinking of adding.
function parseCandidate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'must be a JSON object' }]);
  const errors = [];
  const out = { mode: 'proxied' };
  const number = (field, min, max, required) => {
    if (!has(body, field)) {
      if (required) errors.push({ field, message: 'is required' });
      return;
    }
    if (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < min || body[field] > max) errors.push({ field, message: `must be a number from ${min} to ${max}` });
    else out[field] = body[field];
  };
  number('vcpus', 1, 1024, true);
  number('memory_gb', 0.5, 16384, true);
  number('port_mbps', 1, 400000, true);
  number('bitrate_kbps', 8, 2000, false);
  number('listeners', 0, 1e9, false);
  if (has(body, 'mode')) {
    if (body.mode !== 'proxied' && body.mode !== 'direct') errors.push({ field: 'mode', message: 'must be "proxied" (a slave behind the master) or "direct" (an edge server with its own DNS record)' });
    else out.mode = body.mode;
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
  if (has(body, 'port_mbps')) {
    if (!Number.isInteger(body.port_mbps) || body.port_mbps < 1 || body.port_mbps > 400000) fail('port_mbps', 'must be the speed of the server\'s network port in Mbit/s, from 1 to 400000');
    else out.port_mbps = body.port_mbps;
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

module.exports = { parseStation, parseUser, parseSettings, parseRates, parseCandidate, checkEmail, parseNode, checkSlug, checkUrl, isPrivateHost, intParam, timeParam, dateParam, RESERVED_SLUGS };
