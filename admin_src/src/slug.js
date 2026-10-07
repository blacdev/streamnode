// A station's listening address (its slug), made for it rather than thought up
// by whoever adds it: the station's name in a form that fits in an address,
// and a short random ending that keeps it unlike every other station's.
//
//   "Power Beats FM"  ->  power-beats-fm-7k2q
//
// The owner may change it to anything that is free. Stations that existed
// before addresses were generated keep the ones they have.

const crypto = require('crypto');
const db = require('./db');
const { checkSlug } = require('./validate');

// No 0/o, 1/l/i: an address is read aloud and copied by hand.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ENDING = 4;
// Leaves room for the ending within the 50 characters an address may have.
const MAX_BASE = 40;

function ending() {
  const bytes = crypto.randomBytes(ENDING);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

// The name as it can appear in an address: plain lower-case letters and
// digits, with one hyphen wherever anything else stood.
function fromName(name) {
  const plain = String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é -> e
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return plain.slice(0, MAX_BASE).replace(/-+$/, '');
}

// One candidate. A name with nothing usable in it (all symbols, or another script) gets "station".
const candidate = (name) => `${fromName(name) || 'station'}-${ending()}`;

async function taken(slug) {
  const { rowCount } = await db.query('SELECT 1 FROM stations WHERE slug = $1', [slug]);
  return rowCount > 0;
}

/** An address for a station of this name that no station has at the moment. */
async function generate(name) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = candidate(name);
    if (!checkSlug(slug) && !(await taken(slug))) return slug;
  }
  throw new Error('no free station address could be made');
}

/** Whether an address could be given to a new station, and if not, why. */
async function check(slug) {
  const problem = checkSlug(slug);
  if (problem === 'is reserved') return { slug, available: false, reason: 'This address is kept for the gateway itself.' };
  if (problem) return { slug, available: false, reason: 'Use lower-case letters, numbers, - and _, up to 50, starting and ending with a letter or number.' };
  if (await taken(slug)) return { slug, available: false, reason: 'Another station already has this address.' };
  return { slug, available: true, reason: null };
}

module.exports = { generate, check, fromName, candidate };
