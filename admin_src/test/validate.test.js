const test = require('node:test');
const assert = require('node:assert');
const v = require('../src/validate');
const security = require('../src/security');

const fields = (fn) => {
  try {
    fn();
    return [];
  } catch (err) {
    return err.details.map((d) => d.field);
  }
};

test('accepts a minimal station', () => {
  const out = v.parseStation({ name: ' Jazz ', slug: 'jazz-fm', primary_url: 'https://a.example.com/live' });
  assert.deepStrictEqual(out, { name: 'Jazz', slug: 'jazz-fm', primary_url: 'https://a.example.com/live' });
});

test('reports every invalid field at once', () => {
  const bad = fields(() => v.parseStation({ name: '', slug: 'Admin!', primary_url: 'ftp://x', backup_url: 'nope' }));
  assert.deepStrictEqual(bad, ['name', 'slug', 'primary_url', 'backup_url']);
});

test('reserved slugs are refused', () => {
  for (const slug of ['admin', 'api', 'healthz']) assert.ok(v.checkSlug(slug), slug);
  assert.strictEqual(v.checkSlug('powerbeats'), null);
});

test('private and loopback sources are refused', () => {
  for (const url of [
    'http://127.0.0.1/live', 'http://localhost:8000/live', 'http://10.0.0.5/s', 'http://192.168.1.9/s',
    'http://169.254.169.254/latest/meta-data', 'http://[::1]/s', 'http://redis_cache:6379/', 'http://2130706433/',
    'http://user:pass@example.com/live',
  ]) {
    assert.ok(v.checkUrl(url), `${url} should be rejected`);
  }
  assert.strictEqual(v.checkUrl('http://stream.example.com:8000/live.mp3'), null);
});

test('blank optional URLs clear the field', () => {
  const out = v.parseStation({ backup_url: '', metadata_url: null }, { partial: true });
  assert.deepStrictEqual(out, { backup_url: null, metadata_url: null });
});

test('tenants cannot set administrator fields', () => {
  const bad = fields(() => v.parseStation({ max_listeners: 5, is_active: false, user_id: 3 }, { partial: true }));
  assert.deepStrictEqual(bad.sort(), ['is_active', 'max_listeners', 'user_id']);
  const ok = v.parseStation({ max_listeners: 5 }, { partial: true, isAdmin: true });
  assert.deepStrictEqual(ok, { max_listeners: 5 });
});

test('passwords verify and keys are well formed', async () => {
  const hash = await security.hashPassword('correct horse battery');
  assert.ok(await security.verifyPassword('correct horse battery', hash));
  assert.ok(!(await security.verifyPassword('wrong', hash)));
  assert.ok(!(await security.verifyPassword('anything', null)));
  assert.match(security.generateApiKey(), /^rgw_[0-9a-f]{48}$/);
});

test('streaming servers validate address, port and weight', () => {
  assert.deepStrictEqual(v.parseNode({ name: 'edge-2', host: '10.0.0.12' }), { name: 'edge-2', host: '10.0.0.12' });
  const bad = fields(() => v.parseNode({ name: '', host: 'http://x:3000', port: 70000, weight: 0 }));
  assert.deepStrictEqual(bad, ['name', 'host', 'port', 'weight']);
  // The built-in server can be re-weighted or drained, not re-addressed.
  assert.deepStrictEqual(v.parseNode({ weight: 50, enabled: false }, { partial: true, builtin: true }), { weight: 50, enabled: false });
  assert.deepStrictEqual(fields(() => v.parseNode({ host: 'x' }, { partial: true, builtin: true })), ['host']);
});

test('live state from several engines is combined', () => {
  const { mergeLive } = require('../src/stations');
  const merged = mergeLive([
    { listeners: '3', source: 'primary', title: 'A', started_at: '200' },
    { listeners: '4', source: 'backup', title: 'A', started_at: '100' },
    { listeners: '0', source: 'none' },
    {},
  ]);
  assert.strictEqual(merged.listeners, 7);
  assert.strictEqual(merged.servers, 2);
  assert.strictEqual(merged.source, 'backup');
  assert.strictEqual(merged.connected_since, new Date(100000).toISOString());
  assert.strictEqual(mergeLive([{}, { source: 'none' }]).online, false);
});

test('capacity: thresholds, stale reports and the add-server verdict', () => {
  const capacity = require('../src/capacity');
  const now = 1000;
  const GB = 1024 ** 3;
  const beat = (cpu, memAvailGb, at = now) => ({
    cpu_percent: String(cpu), cpu_cores: '4', load_1m: '1.0', memory_total: String(16 * GB), memory_available: String(memAvailGb * GB),
    disk_total: String(100 * GB), disk_free: String(50 * GB), network_out_bps: '1000', listeners: '10', stations: '2', started_at: '900', reported_at: String(at),
  });
  const calm = capacity.resources(beat(20, 12), now);
  assert.strictEqual(calm.status, 'ok');
  assert.strictEqual(calm.memory.percent, 25);
  assert.strictEqual(calm.disk.percent, 50);
  assert.strictEqual(capacity.resources(beat(20, 12, now - 60), now), null, 'stale report is ignored');
  assert.strictEqual(capacity.resources({}, now), null);

  const server = (name, res, enabled = true) => ({ name, enabled, resources: res });
  assert.strictEqual(capacity.assess([server('a', calm)]).add_server_recommended, false);

  const full = capacity.resources(beat(20, 1), now); // 93.8% memory
  const verdict = capacity.assess([server('a', calm), server('b', full)]);
  assert.strictEqual(verdict.status, 'critical');
  assert.strictEqual(verdict.add_server_recommended, true);
  assert.match(verdict.reasons.join('|'), /b: memory at 93\.8%/);

  const busy = capacity.resources(beat(80, 12), now); // warning-level CPU everywhere
  assert.strictEqual(capacity.assess([server('a', busy), server('b', busy)]).add_server_recommended, true);
  // One busy server among calm ones is a warning, not yet a reason to add capacity.
  const mixed = capacity.assess([server('a', busy), server('b', calm), server('c', calm)]);
  assert.strictEqual(mixed.status, 'warning');
  assert.strictEqual(mixed.add_server_recommended, false);

  assert.match(capacity.assess([server('ghost', null)]).reasons[0], /not reporting/);
});

test('audio state: detected, forced and pending overrides', () => {
  const { audioState, assess } = require('../src/capacity');
  const now = 1000;
  const beat = (extra) => ({ reported_at: String(now), ...extra });
  assert.deepStrictEqual(audioState(beat({ audio: 'ok' }), {}, now), { status: 'ok', reason: null, since: null, forced: false });
  const detected = audioState(beat({ audio: 'no_audio', audio_reason: 'cannot get audio from the source of jazz', audio_since: '900', audio_forced: 'false' }), {}, now);
  assert.strictEqual(detected.status, 'no_audio');
  assert.strictEqual(detected.forced, false);
  assert.strictEqual(detected.since, new Date(900000).toISOString());
  // Forced on the master but the engine has not picked it up yet.
  assert.deepStrictEqual(audioState(beat({ audio: 'ok' }), { audio_override: 'maintenance' }, now), { status: 'no_audio', reason: 'maintenance', since: null, forced: true });
  assert.strictEqual(audioState({}, {}, now), null);

  const verdict = assess([{ name: 'edge-2', enabled: true, resources: null, audio: detected }]);
  assert.match(verdict.reasons.join('|'), /edge-2: no audio: cannot get audio/);
  assert.strictEqual(verdict.status, 'warning');
});

test('per-station silence is reported per server', () => {
  const { silentServers } = require('../src/stations');
  const nodes = ['local', 'edge-2'];
  const byNode = [{}, { jazz: '1700000000|primary: source answered HTTP 404', news: '1700000100|' }];
  assert.deepStrictEqual(silentServers('jazz', nodes, byNode), [
    { server: 'edge-2', since: new Date(1700000000000).toISOString(), reason: 'primary: source answered HTTP 404' },
  ]);
  assert.deepStrictEqual(silentServers('news', nodes, byNode)[0].reason, null);
  assert.deepStrictEqual(silentServers('rock', nodes, byNode), []);
  assert.deepStrictEqual(silentServers('jazz', nodes, [null, undefined]), []);
});
