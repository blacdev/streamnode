const test = require('node:test');
const assert = require('node:assert');
const costs = require('../src/costs');
const billing = require('../src/billing');
const notify = require('../src/notify');
const haproxy = require('../src/haproxy');
const v = require('../src/validate');

const GB = 1024 ** 3;
const M = costs.DEFAULTS; // 0.0001 core per listener for the engine, the same again for the proxy
const server = (name, extra = {}) => ({ name, mode: 'proxied', builtin: false, weight: 100, enabled: true, cores: 4, memory_bytes: 8 * GB, port_mbps: 1000, ...extra });
const master = { cores: 4, memory_bytes: 8 * GB, port_mbps: 1000 };

test('one machine is limited by its port at high bitrates and its processor at low ones', () => {
  const machine = { cores: 4, memory_bytes: 8 * GB, port_mbps: 1000 };
  const high = costs.machineCapacity(machine, 320, M, { engine: true, proxy: true });
  assert.strictEqual(high.limited_by, 'network');
  assert.strictEqual(high.listeners, Math.floor((1000 * 1000 * 0.75) / (320 * 1.07)));
  const low = costs.machineCapacity(machine, 32, M, { engine: true, proxy: true });
  assert.strictEqual(low.limited_by, 'processor');
  assert.strictEqual(low.listeners, 15000); // 4 cores x 75% / 0.0002 per listener
});

test('a slave adds engine capacity but never more than the master can pass on', () => {
  const single = costs.clusterCapacity(master, [server('local', { builtin: true })], 128, M);
  const withSlave = costs.clusterCapacity(master, [server('local', { builtin: true }), server('edge-2')], 128, M);
  const port = Math.floor((1000 * 1000 * 0.75) / (128 * 1.07));
  assert.ok(single.listeners <= port);
  assert.ok(withSlave.listeners >= single.listeners);
  assert.ok(withSlave.listeners <= port, 'everything still passes through the master\'s port');
  assert.strictEqual(withSlave.limited_by, "the master's network port");
  // A direct (edge) server is outside that limit.
  const withEdge = costs.clusterCapacity(master, [server('local', { builtin: true }), server('edge-3', { mode: 'direct' })], 128, M);
  assert.ok(withEdge.listeners > port);
  assert.strictEqual(withEdge.direct, port);
});

test('listeners spread by weight behind the master, and equally between DNS addresses', () => {
  const byWeight = costs.spread(900, [server('a', { weight: 100 }), server('b', { weight: 200 })]);
  assert.deepStrictEqual([Math.round(byWeight.a), Math.round(byWeight.b)], [300, 600]);
  const withEdge = costs.spread(900, [server('a'), server('b'), server('e', { mode: 'direct' })]);
  assert.deepStrictEqual([withEdge.a, withEdge.b, withEdge.e], [225, 225, 450]);
});

test('the calculator says what a new server changes', () => {
  const now = { master, engines: [server('local', { builtin: true })], listeners: 4000, bitrate: 128 };
  const slave = costs.estimate({ ...now, candidate: { vcpus: 4, memory_gb: 8, port_mbps: 1000, mode: 'proxied' } }, M);
  assert.strictEqual(slave.load_now.before.servers.local.listeners, 4000);
  assert.strictEqual(slave.load_now.after.servers.local.listeners, 2000);
  assert.strictEqual(slave.load_now.after.servers['new server'].listeners, 2000);
  assert.strictEqual(slave.load_now.before.master.traffic_mbps, slave.load_now.after.master.traffic_mbps, 'a slave moves no traffic off the master');
  assert.ok(slave.load_now.after.master.processor_percent < slave.load_now.before.master.processor_percent);
  const edge = costs.estimate({ ...now, candidate: { vcpus: 4, memory_gb: 8, port_mbps: 1000, mode: 'direct' } }, M);
  assert.strictEqual(edge.load_now.after.master.traffic_mbps, edge.load_now.before.master.traffic_mbps / 2);
  assert.ok(edge.capacity.gained > slave.capacity.gained);
  assert.ok(edge.notes.length >= 3);
});

test('the price of a listener follows from what a server costs and carries', () => {
  const rates = { ...billing.DEFAULT_RATES, server_monthly_cost: 60, margin_percent: 50 };
  const at128 = billing.listenerRate(rates, M, 128);
  assert.strictEqual(at128.listeners_per_server, Math.floor(750000 / (128 * 1.07)));
  assert.ok(Math.abs(at128.price_per_listener - (60 / at128.listeners_per_server) * 1.5) < 1e-6);
  // A higher bitrate fits fewer listeners on a server, so each costs more.
  assert.ok(billing.listenerRate(rates, M, 320).price_per_listener > at128.price_per_listener);
});

test('a station\'s standing', () => {
  assert.strictEqual(billing.standing({}, { percent_of_limit: 40 }, null), 'ok');
  assert.strictEqual(billing.standing({}, { percent_of_limit: 80 }, 60), 'near_limit');
  assert.strictEqual(billing.standing({}, { percent_of_limit: 100 }, 60), 'at_limit');
  assert.strictEqual(billing.standing({}, { percent_of_limit: 10 }, 3), 'expiring');
  assert.strictEqual(billing.standing({}, { percent_of_limit: null }, -1), 'expired');
});

test('notices are due at the right levels and repeat more often near the limit', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const bill = (percent, daysLeft, storagePercent) => ({
    stations: [{ station: 'jazz', name: 'Jazz FM', usage: { percent_of_limit: percent, peak_listeners_this_month: percent }, plan: { max_listeners: 100, days_left: daysLeft, subscription_ends_on: '2026-03-17' } }],
    storage: { percent_used: storagePercent, used_bytes: 50 * 1024 ** 2, quota_bytes: 100 * 1024 ** 2 },
  });
  assert.deepStrictEqual(notify.due(bill(40, null, 10), now), []);
  const half = notify.due(bill(55, null, null), now);
  assert.deepStrictEqual([half[0].kind, half[0].threshold, half[0].period], ['listeners', 50, '2026-03']);
  assert.strictEqual(notify.due(bill(80, null, null), now)[0].period, '2026-w09');
  assert.strictEqual(notify.due(bill(95, null, null), now)[0].period, '2026-03-10');
  const full = notify.due(bill(120, 7, 92), now);
  assert.deepStrictEqual(full.map((n) => [n.kind, n.threshold]), [['listeners', 100], ['subscription', 7], ['storage', 90]]);
  assert.match(full[0].subject, /has reached its listener limit/);
  // Six days left is not one of the days a subscription notice goes out.
  assert.strictEqual(notify.due(bill(10, 6, null), now).length, 0);
});

test('HAProxy\'s own figures are read from "show info"', () => {
  const info = haproxy.parseInfo('Name: HAProxy\nNbthread: 4\nCurrConns: 2000\nIdle_pct: 85\nPoolAlloc_MB: 96\nBytesOutRate: 24000000\n');
  assert.deepStrictEqual(info, { threads: 4, cores_used: 0.6, connections: 2000, memory_bytes: 96 * 1024 * 1024, bytes_out_per_second: 24000000 });
  assert.strictEqual(haproxy.parseInfo('nothing useful'), null);
});

test('billing fields and the calculator\'s input are validated', () => {
  const base = { name: 'Jazz', slug: 'jazz', primary_url: 'https://a.example.com/live' };
  const admin = v.parseStation({ ...base, max_listeners: 500, billing_bitrate_kbps: 96, discount_percent: 12.5, price_override: null, subscription_ends_on: '2026-12-31' }, { isAdmin: true });
  assert.deepStrictEqual([admin.max_listeners, admin.billing_bitrate_kbps, admin.discount_percent, admin.price_override, admin.subscription_ends_on], [500, 96, 12.5, null, '2026-12-31']);
  // A station's owner cannot set any of them.
  assert.throws(() => v.parseStation({ ...base, max_listeners: 500 }));
  assert.throws(() => v.parseStation({ ...base, discount_percent: 50 }));
  assert.throws(() => v.parseStation({ ...base, subscription_ends_on: '2030-01-01' }));
  assert.throws(() => v.parseStation({ ...base, user_id: 2 }));
  assert.deepStrictEqual(v.parseCandidate({ vcpus: 4, memory_gb: 8, port_mbps: 1000 }), { mode: 'proxied', vcpus: 4, memory_gb: 8, port_mbps: 1000 });
  assert.throws(() => v.parseCandidate({ vcpus: 4, memory_gb: 8 }));
  assert.deepStrictEqual(v.parseUser({ email: ' a@b.example ', discount_percent: 10 }, { partial: true }), { email: 'a@b.example', discount_percent: 10 });
  assert.throws(() => v.parseUser({ email: 'not-an-address' }, { partial: true }));
  assert.strictEqual(v.parseSettings({ smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', from: 'StreamNode <noreply@example.com>' } }).smtp.from, 'StreamNode <noreply@example.com>');
  assert.throws(() => v.parseSettings({ smtp: { security: 'ssl' } }));
});
