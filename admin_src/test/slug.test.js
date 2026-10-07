const test = require('node:test');
const assert = require('node:assert');
const slug = require('../src/slug');
const { checkSlug } = require('../src/validate');

test('a name is put in a form that fits in an address', () => {
  assert.strictEqual(slug.fromName('Power Beats FM'), 'power-beats-fm');
  assert.strictEqual(slug.fromName('  Café & Jazz — 96.5!  '), 'cafe-and-jazz-96-5');
  assert.strictEqual(slug.fromName('Rock_N_Roll'), 'rock-n-roll');
  // Nothing usable: another script, or only symbols.
  assert.strictEqual(slug.fromName('Радио'), '');
  assert.strictEqual(slug.fromName('!!!'), '');
  // Long names are cut, never left ending in a hyphen.
  const long = slug.fromName('a'.repeat(39) + ' bcd efg');
  assert.ok(long.length <= 40 && !long.endsWith('-'), long);
});

test('every candidate is a valid address with a random ending', () => {
  const seen = new Set();
  for (const name of ['Power Beats FM', 'Радио', '', 'x'.repeat(100), 'Admin']) {
    for (let i = 0; i < 50; i += 1) {
      const made = slug.candidate(name);
      assert.strictEqual(checkSlug(made), null, made);
      assert.match(made, /-[a-hj-km-np-z2-9]{4}$/, made);
      seen.add(made);
    }
  }
  // 250 made, and the endings do not repeat in practice.
  assert.ok(seen.size > 240, String(seen.size));
  assert.match(slug.candidate('Радио'), /^station-/);
});
