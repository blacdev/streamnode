const crypto = require('crypto');
const path = require('path');
const express = require('express');

const config = require('./src/config');
const db = require('./src/db');
const { redis } = require('./src/cache');
const auth = require('./src/auth');
const stations = require('./src/stations');
const stats = require('./src/stats');
const haproxy = require('./src/haproxy');
const cluster = require('./src/cluster');
const updates = require('./src/updates');
const media = require('./src/media');
const capacity = require('./src/capacity');
const notify = require('./src/notify');
const routes = require('./src/routes');
const openapi = require('./src/openapi');
const { errorHandler } = require('./src/errors');

const app = express();
app.disable('x-powered-by');
// One proxy hop (HAProxy) sits in front, so req.ip and req.protocol come from its headers.
app.set('trust proxy', 1);

app.use((req, res, next) => {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.set({
    'X-Request-Id': req.id,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // Artwork and the preview player load from station-supplied hosts.
    'Content-Security-Policy':
      "default-src 'self'; img-src * data:; media-src *; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  });
  next();
});

// Cross-origin access to the authenticated API is opt-in (CORS_ORIGINS).
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  const allowed = config.corsOrigins.includes('*') || (origin && config.corsOrigins.includes(origin));
  if (origin && allowed) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization, X-File-Name',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '64kb' }));

// Interactive documentation.
const swaggerAssets = require('swagger-ui-dist').getAbsoluteFSPath();
app.get('/api/v1/openapi.json', (req, res) => res.json(openapi));
app.use('/api/v1/docs/assets', express.static(swaggerAssets, { index: false, maxAge: '1d' }));
app.get('/api/v1/docs/init.js', (req, res) => res.sendFile(path.join(__dirname, 'docs', 'init.js')));
app.get('/api/v1/docs', (req, res) => res.sendFile(path.join(__dirname, 'docs', 'index.html')));

app.use('/api/v1', routes);

app.use('/admin', express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/admin/'));

app.use(errorHandler);

// Runs a periodic job without letting one failure stop the next run.
function every(ms, name, job) {
  const run = () => job().catch((err) => console.error(`[${name}]`, err.message));
  setInterval(run, ms).unref();
}

async function main() {
  await db.migrate();
  await redis.connect();
  await auth.bootstrap();
  await cluster.ensureLocalEngine();
  await media.init();
  console.log(`[stations] published ${await stations.syncAll()} station profile(s) to the engine registry`);

  every(config.statsFlushMs, 'stats-flush', stats.flush);
  every(config.stationSyncMs, 'station-sync', stations.syncAll);
  await cluster.publishOverrides();
  every(config.stationSyncMs, 'audio-overrides', cluster.publishOverrides);
  every(3600 * 1000, 'retention', stats.prune);
  // What a listener costs is learned from the running servers, a little at a time.
  every(30 * 1000, 'costs', capacity.sample);
  every(10 * 60 * 1000, 'notices', notify.run);
  media.sync().catch((err) => console.error('[files]', err.message));
  every(config.stationSyncMs, 'files', media.sync);
  if (updates.enabled()) {
    updates.check();
    every(config.updateCheckMs, 'update-check', updates.check);
  }
  await updates.publishVersion();
  every(config.stationSyncMs, 'version-publish', updates.publishVersion);
  if (haproxy.enabled()) {
    haproxy.sync().catch(() => {});
    // Failures are already logged once by the sync itself.
    setInterval(() => haproxy.sync().catch(() => {}), config.haproxySyncMs).unref();
  }

  const server = app.listen(config.port, () => console.log(`[api] management API listening on port ${config.port}`));

  const shutdown = async (signal) => {
    console.log(`[api] ${signal} received, shutting down`);
    server.close();
    // Never hang on an unreachable Redis or database; unsaved counters stay in Redis.
    setTimeout(() => process.exit(0), 8000).unref();
    await stats.flush().catch((err) => console.error('[stats-flush]', err.message));
    await Promise.allSettled([redis.quit(), db.pool.end()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
