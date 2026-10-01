const { createClient } = require('redis');
const config = require('./config');

const redis = createClient({
  url: config.redisUrl,
  socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 3000) },
});
redis.on('error', (err) => console.error('[redis]', err.message));

module.exports = { redis };
