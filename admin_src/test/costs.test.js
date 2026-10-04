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
  // `percent` is the most the station reached this month; `today` and `week` default to the same.
  const bill = (percent, daysLeft, storagePercent, today = percent, week = percent) => ({
    stations: [{
      station: 'jazz', name: 'Jazz FM',
      usage: {
        listeners_now: 12, percent_of_limit: 12,
        peak_listeners_today: today, peak_listeners_last_7_days: week, peak_listeners_this_month: percent,
        peak_percent_today: today, peak_percent_last_7_days: week, peak_percent_this_month: percent,
        at_limit: { now: false, minutes_today: today >= 100 ? 9 : 0, minutes_last_7_days: 9, minutes_this_month: 9, last_reached_at: null },
      },
      plan: { max_listeners: 100, days_left: daysLeft, subscription_ends_on: '2026-03-17' },
    }],
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
  assert.match(full[0].text, /full for about 9 minutes today/);
  // Reaching the limit once does not go on producing notices. Full three weeks ago, quiet since:
  // nothing daily or weekly is due, only the monthly one.
  const earlier = notify.due(bill(100, null, null, 30, 40), now);
  assert.deepStrictEqual(earlier.map((n) => [n.threshold, n.period]), [[50, '2026-03']]);
  // Full two days ago, quiet today: the weekly notice, not the daily one.
  const thisWeek = notify.due(bill(100, null, null, 30, 100), now);
  assert.deepStrictEqual(thisWeek.map((n) => [n.threshold, n.period]), [[75, '2026-w09']]);
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

test('pay as you go is charged by lots of extra listeners per minute', () => {
  const rates = { ...billing.DEFAULT_RATES, payg_block_listeners: 10, payg_block_minutes: 1, payg_price_per_block: 0.05 };
  // 200 listeners over for 5 minutes: 20 lots a minute, 100 lot-minutes.
  assert.strictEqual(billing.overageCharge(rates, Math.ceil(200 / 10) * 5), 5);
  // The same lots charged per 5 minutes rather than per minute cost a fifth.
  assert.strictEqual(billing.overageCharge({ ...rates, payg_block_minutes: 5 }, 100), 1);
  // On pay as you go a station past its number is being charged, not stopped, until it meets its ceiling.
  const usage = (now, full) => ({ percent_of_limit: now, pay_as_you_go: { active_now: now > 100 }, at_limit: { now: full } });
  assert.strictEqual(billing.standing({}, usage(140, false), null), 'pay_as_you_go');
  assert.strictEqual(billing.standing({}, usage(200, true), null), 'at_limit');
  assert.strictEqual(billing.standing({}, usage(80, false), null), 'near_limit');
});

test('notices can be thinned out, and say when a station goes onto pay as you go', () => {
  assert.deepStrictEqual(notify.levelsFrom([100, 60]), [{ percent: 100, every: 'day' }, { percent: 60, every: 'month' }]);
  const now = new Date('2026-03-10T12:00:00Z');
  const station = (extra) => ({
    station: 'jazz', name: 'Jazz FM', pay_as_you_go_charge: 3.7,
    usage: {
      listeners_now: 140, percent_of_limit: 140, peak_listeners_today: 160, peak_listeners_last_7_days: 160, peak_listeners_this_month: 160,
      peak_percent_today: 160, peak_percent_last_7_days: 160, peak_percent_this_month: 160, at_limit: { now: false, minutes_today: 0 },
      pay_as_you_go: extra,
    },
    plan: { max_listeners: 100, listener_ceiling: 300, days_left: null, subscription_ends_on: null },
  });
  const storage = { percent_used: 10, used_bytes: 1, quota_bytes: 10, pay_as_you_go: false, over_quota_bytes: 0 };
  const on = notify.due({ currency: 'USD', stations: [station({ active_now: true, minutes_this_month: 37, most_extra_listeners: 60, last_at: null })], storage }, now);
  // One notice, about pay as you go: not a "reached its limit", and nothing more about approaching it.
  assert.deepStrictEqual(on.map((n) => [n.kind, n.threshold]), [['pay_as_you_go', 0]]);
  // Before it gets there, a station on pay as you go is told it is approaching its number like any other.
  const near = station(null); near.usage = { ...near.usage, pay_as_you_go: { active_now: false, minutes_this_month: 0, most_extra_listeners: 0, last_at: null }, peak_percent_today: 92, peak_listeners_today: 92 };
  assert.deepStrictEqual(notify.due({ currency: 'USD', stations: [near], storage }, now).map((n) => [n.kind, n.threshold]), [['listeners', 90]]);
  assert.match(on[0].text, /USD 3\.70/);
  assert.match(on[0].text, /No more than 300 listeners/);
  // With only the 100% level kept, a pay-as-you-go station gets just the one notice.
  const thin = notify.due({ currency: 'USD', stations: [station({ active_now: true, minutes_this_month: 37, most_extra_listeners: 60, last_at: null })], storage }, now, notify.levelsFrom([100]));
  assert.deepStrictEqual(thin.map((n) => n.kind), ['pay_as_you_go']);
  // Storage beyond its quota on pay as you go is said once a week, in place of "storage is full".
  const over = notify.due({ currency: 'USD', stations: [], storage: { percent_used: 130, used_bytes: 13 * 1024 ** 2, quota_bytes: 10 * 1024 ** 2, pay_as_you_go: true, over_quota_bytes: 3 * 1024 ** 2, pay_as_you_go_charge: 0.5 } }, now);
  assert.deepStrictEqual(over.map((n) => [n.kind, n.period]), [['pay_as_you_go', '2026-w09']]);
  assert.deepStrictEqual(v.parseSettings({ notices: { automatic: false, levels: [100, 75, 75], min_days_between: 7 } }).notices, { automatic: false, levels: [75, 100], min_days_between: 7 });
  assert.throws(() => v.parseSettings({ notices: { levels: [150] } }));
  const admin = v.parseStation({ name: 'J', slug: 'j', primary_url: 'https://a.example.com/x', overage_mode: 'pay_as_you_go', listener_ceiling: 800 }, { isAdmin: true });
  assert.deepStrictEqual([admin.overage_mode, admin.listener_ceiling], ['pay_as_you_go', 800]);
  assert.throws(() => v.parseStation({ name: 'J', slug: 'j', primary_url: 'https://a.example.com/x', overage_mode: 'pay_as_you_go' }));
});

test('a bandwidth plan is priced by the gigabyte, in step with the price of a listener', () => {
  const rates = { ...billing.DEFAULT_RATES, server_monthly_cost: 60, margin_percent: 50 };
  const listener = billing.listenerRate(rates, M, 128);
  const data = billing.bandwidthRate(rates, M, 128);
  // One listener who never leaves receives about 42 GB a month at 128 kbps, and costs the same either way.
  assert.ok(Math.abs(data.price_per_gb * 42.048 - listener.price_per_listener) < 1e-4);
  assert.strictEqual(data.listener_hours_per_gb, 17.36);
  assert.strictEqual(data.pay_as_you_go_price_per_gb, data.price_per_gb);
  // The administrator's own prices replace the worked-out ones.
  const set = billing.bandwidthRate({ ...rates, bandwidth_price_per_gb: 0.02, payg_bandwidth_price_per_gb: 0.05 }, M, 128);
  assert.deepStrictEqual([set.price_per_gb, set.pay_as_you_go_price_per_gb, set.source], [0.02, 0.05, 'set']);

  // How such a station stands: by its data, not its listeners.
  const usage = (percent, over) => ({ bandwidth: { percent_used: percent, over_gb: over }, at_limit: null });
  assert.strictEqual(billing.standing({ overage_mode: 'capped' }, usage(40, 0), null), 'ok');
  assert.strictEqual(billing.standing({ overage_mode: 'capped' }, usage(80, 0), null), 'near_limit');
  assert.strictEqual(billing.standing({ overage_mode: 'pay_as_you_go' }, usage(120, 40), null), 'pay_as_you_go');
  assert.strictEqual(billing.standing({ overage_mode: 'capped', blocked: 'bandwidth' }, usage(100, 0), null), 'out_of_bandwidth');

  const admin = v.parseStation({ name: 'J', slug: 'j', primary_url: 'https://a.example.com/x', plan_type: 'bandwidth', bandwidth_gb: 500 }, { isAdmin: true });
  assert.deepStrictEqual([admin.plan_type, admin.bandwidth_gb], ['bandwidth', 500]);
  assert.throws(() => v.parseStation({ name: 'J', slug: 'j', primary_url: 'https://a.example.com/x', plan_type: 'bandwidth' }));
});

test('a bandwidth plan sends each of its notices once in a month', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const station = (data, mode = 'capped', blocked = null) => ({
    station: 'mobile', name: 'Jazz Mobile', blocked, pay_as_you_go_charge: 1.25,
    usage: { listeners_now: 30, bandwidth: { allowance_gb: 500, remaining_listener_hours: 1700, projected_gb: 900, ...data }, pay_as_you_go: null, at_limit: null },
    plan: { type: 'bandwidth', overage_mode: mode, days_left: null, subscription_ends_on: null },
  });
  const storage = { percent_used: 10, used_bytes: 1, quota_bytes: 10, pay_as_you_go: false, over_quota_bytes: 0 };
  const due = (s) => notify.due({ currency: 'USD', stations: [s], storage }, now).map((n) => [n.kind, n.threshold, n.period]);
  assert.deepStrictEqual(due(station({ used_gb: 100, remaining_gb: 400, over_gb: 0, percent_used: 20 })), []);
  assert.deepStrictEqual(due(station({ used_gb: 400, remaining_gb: 100, over_gb: 0, percent_used: 80 })), [['bandwidth', 75, '2026-03']]);
  assert.deepStrictEqual(due(station({ used_gb: 500, remaining_gb: 0, over_gb: 0, percent_used: 100 }, 'capped', 'bandwidth')), [['bandwidth', 100, '2026-03']]);
  assert.deepStrictEqual(due(station({ used_gb: 560, remaining_gb: 0, over_gb: 60, percent_used: 112 }, 'pay_as_you_go')), [['pay_as_you_go', 0, '2026-03']]);
});
