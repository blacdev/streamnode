const config = require('./config');
const db = require('./db');
const { redis } = require('./cache');
const { wrap, unauthorized, forbidden, HttpError } = require('./errors');
const security = require('./security');

const USER_COLUMNS = 'u.id, u.username, u.role, u.external_id, u.max_stations, u.storage_quota_mb, u.email, u.discount_percent, u.is_active';
const LOGIN_WINDOW_SECS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 10;

function tokenFrom(req) {
  const header = req.get('x-api-key');
  if (header) return header.trim();
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  return match ? match[1] : null;
}

async function resolveToken(token) {
  if (token.startsWith(security.KEY_PREFIX)) {
    const { rows } = await db.query(
      `SELECT ${USER_COLUMNS}, k.id AS key_id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
      [security.sha256(token)]
    );
    if (!rows[0]) return null;
    // Throttled so a busy integration does not write on every request.
    db.query(
      "UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')",
      [rows[0].key_id]
    ).catch(() => {});
    return { ...rows[0], via: 'api_key' };
  }
  if (token.startsWith('rgs_')) {
    const userId = await redis.get(`session:${security.sha256(token)}`);
    if (!userId) return null;
    const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [userId]);
    return rows[0] ? { ...rows[0], via: 'session' } : null;
  }
  return null;
}

const authenticate = wrap(async (req, res, next) => {
  const token = tokenFrom(req);
  if (!token) throw unauthorized('Send an API key in the X-API-Key header or a session token as a Bearer token.');
  const user = await resolveToken(token);
  if (!user) throw unauthorized('The API key or session token is not valid.');
  if (!user.is_active) throw forbidden('This account is disabled.');
  req.user = user;
  req.token = token;
  next();
});

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return next(forbidden('Administrator access is required.'));
  next();
}

async function login(req, username, password) {
  const attemptsKey = `login:${req.ip}`;
  const attempts = await redis.incr(attemptsKey);
  if (attempts === 1) await redis.expire(attemptsKey, LOGIN_WINDOW_SECS);
  if (attempts > LOGIN_MAX_ATTEMPTS) {
    throw new HttpError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again in 15 minutes.');
  }

  const { rows } = await db.query(
    'SELECT id, username, role, external_id, max_stations, storage_quota_mb, email, discount_percent, is_active, password_hash FROM users WHERE username = $1',
    [username]
  );
  const user = rows[0];
  const ok = user && user.password_hash && (await security.verifyPassword(password, user.password_hash));
  if (!ok || !user.is_active) throw unauthorized('Incorrect username or password.');

  await redis.del(attemptsKey);
  const token = security.generateSessionToken();
  await redis.set(`session:${security.sha256(token)}`, String(user.id), { EX: config.sessionTtlSecs });
  delete user.password_hash;
  return { token, expires_in: config.sessionTtlSecs, user };
}

async function logout(req) {
  if (req.user.via === 'session') await redis.del(`session:${security.sha256(req.token)}`);
}

// Makes the operator account and bootstrap key match the environment.
async function bootstrap() {
  const passwordHash = config.adminPassword ? await security.hashPassword(config.adminPassword) : null;
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (username) DO UPDATE
       SET role = 'admin', is_active = true, password_hash = COALESCE($2, users.password_hash), updated_at = now()
     RETURNING id`,
    [config.adminUsername, passwordHash]
  );
  const adminId = rows[0].id;

  const key = config.adminApiKey;
  if (key) {
    if (!key.startsWith(security.KEY_PREFIX) || key.length < 36) {
      console.error(`[auth] ADMIN_API_KEY ignored: it must start with "${security.KEY_PREFIX}" and be at least 36 characters.`);
    } else {
      const hash = security.sha256(key);
      await db.query("DELETE FROM api_keys WHERE user_id = $1 AND name = 'bootstrap' AND key_hash <> $2", [adminId, hash]);
      await db.query(
        "INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'bootstrap', $2, $3) ON CONFLICT (key_hash) DO NOTHING",
        [adminId, security.keyPrefix(key), hash]
      );
    }
  }
  if (!config.adminPassword && !key) {
    console.warn('[auth] Neither ADMIN_PASSWORD nor ADMIN_API_KEY is set: nobody can sign in until one is configured.');
  }
}

module.exports = { authenticate, requireAdmin, login, logout, bootstrap };
