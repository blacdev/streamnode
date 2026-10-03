const env = process.env;

const int = (key, fallback) => {
  const n = parseInt(env[key], 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key) => /^(1|true|yes|on)$/i.test(env[key] || '');
const text = (key, fallback = '') => (env[key] || '').trim() || fallback;

module.exports = {
  port: int('PORT', 8000),
  databaseUrl: text('DATABASE_URL'),
  redisUrl: text('REDIS_URL', 'redis://redis_cache:6379'),

  // Public origin of the gateway (e.g. https://stream.example.com). Used to
  // build stream URLs in API responses; derived from the request when unset.
  publicBaseUrl: text('PUBLIC_BASE_URL').replace(/\/+$/, ''),

  // Operator account and bootstrap key, re-applied from the environment on every start.
  adminUsername: text('ADMIN_USERNAME', 'admin'),
  adminPassword: text('ADMIN_PASSWORD'),
  adminApiKey: text('ADMIN_API_KEY'),

  // Browser origins allowed to call the authenticated API ('*' or a comma list).
  corsOrigins: text('CORS_ORIGINS').split(',').map((o) => o.trim()).filter(Boolean),

  allowPrivateSources: bool('ALLOW_PRIVATE_SOURCES'),

  // Stations a new tenant account may create unless the administrator says otherwise.
  defaultMaxStations: int('DEFAULT_MAX_STATIONS', 5),

  // What a joining slave node is given.
  // The engine on this same server ("both" installs), as host:port; empty on a master-only install.
  localEngine: text('LOCAL_ENGINE'),
  // Secret HAProxy sends to engines so they accept listeners only through it.
  engineSecret: text('ENGINE_SECRET'),
  redisPassword: text('REDIS_PASSWORD'),
  // Public port where slaves reach Redis (TLS, through HAProxy).
  clusterPort: int('CLUSTER_PORT', 6380),
  clusterTls: !/^(0|false|no|off)$/i.test(env.CLUSTER_TLS || ''),
  // Address slaves use for Redis when it is not the master's public name
  // (the domain's TLS is terminated elsewhere, or a private address is preferred).
  clusterHost: text('CLUSTER_HOST'),
  // Where the domain's certificate comes from: letsencrypt | provided | external | selfsigned.
  tlsMode: text('TLS_MODE', 'selfsigned'),
  joinTokenMinutes: int('JOIN_TOKEN_MINUTES', 60),

  // The commit this image was built from, and the repository watched for newer ones.
  version: text('GATEWAY_VERSION'),
  updateRepo: text('UPDATE_REPO'),
  updateBranch: text('UPDATE_BRANCH', 'main'),
  updateCheckMs: int('UPDATE_CHECK_HOURS', 6) * 3600 * 1000,
  // Directory shared with the host, through which the dashboard steers the updater.
  controlDir: text('CONTROL_DIR', '/control'),

  // Uploaded idents and fallback audio. With Dropbox connected, local copies
  // beyond FILE_CACHE_MB are dropped and fetched again when needed.
  filesDir: text('FILES_DIR', '/files'),
  fileCacheMb: int('FILE_CACHE_MB', 2048),
  dropboxAuthUrl: text('DROPBOX_AUTH_URL', 'https://www.dropbox.com').replace(/\/+$/, ''),
  dropboxApiUrl: text('DROPBOX_API_URL', 'https://api.dropboxapi.com').replace(/\/+$/, ''),
  dropboxContentUrl: text('DROPBOX_CONTENT_URL', 'https://content.dropboxapi.com').replace(/\/+$/, ''),

  // HAProxy runtime API (host:port), used to add and remove streaming servers.
  // Empty disables server management.
  haproxyAdmin: text('HAPROXY_ADMIN'),
  haproxyBackend: text('HAPROXY_BACKEND', 'streaming_engine_backend'),
  haproxySyncMs: int('HAPROXY_SYNC_SECS', 5) * 1000,

  // CPU, memory or disk use (percent) at which a server is flagged.
  capacityWarningPercent: int('CAPACITY_WARNING_PERCENT', 75),
  capacityCriticalPercent: int('CAPACITY_CRITICAL_PERCENT', 90),
  sessionTtlSecs: int('SESSION_TTL_SECS', 12 * 3600),
  statsFlushMs: int('STATS_FLUSH_SECS', 60) * 1000,
  stationSyncMs: int('STATION_SYNC_SECS', 300) * 1000,
  minuteRetentionDays: int('STATS_MINUTE_RETENTION_DAYS', 90),
  auditRetentionDays: int('AUDIT_RETENTION_DAYS', 365),
};
