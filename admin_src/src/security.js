const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_PREFIX = 'rgw_';

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(derived, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function generateApiKey() {
  return KEY_PREFIX + crypto.randomBytes(24).toString('hex');
}

const generateSessionToken = () => 'rgs_' + crypto.randomBytes(32).toString('hex');

// What is safe to show after creation: enough to recognise a key, not to use it.
const keyPrefix = (key) => key.slice(0, 12);

module.exports = { hashPassword, verifyPassword, sha256, generateApiKey, generateSessionToken, keyPrefix, KEY_PREFIX };
