// What a station and an account cost per month.
//
// The price follows from what the gateway has to provide: a station is sold
// a number of listeners at its stream's bitrate, and an account a storage
// allowance. The rate per listener is worked out from what a server costs the
// operator and how many listeners at that bitrate such a server can carry
// (from the measured per-listener costs), plus the operator's margin. The
// administrator can replace a station's price outright, or take a percentage
// off a station or a whole account.

const db = require('./db');
const settings = require('./settings');
const costs = require('./costs');
const stations = require('./stations');
const media = require('./media');

const DEFAULT_RATES = Object.freeze({
  currency: 'USD',
  // What one server of the size below costs the operator per month. 0 leaves prices unset.
  server_monthly_cost: 0,
  server_vcpus: 4,
  server_memory_gb: 8,
  server_port_mbps: 1000,
  // Added on top of cost, in percent.
  margin_percent: 0,
  // Per gigabyte of an account's storage allowance, per month.
  storage_price_per_gb: 0,
  // Pay as you go, for stations set to it: for every this many listeners over
  // the subscription's number (or part of that many)...
  payg_block_listeners: 10,
  // ...for every this many minutes...
  payg_block_minutes: 1,
  // ...this much is charged.
  payg_price_per_block: 0,
  // And for accounts set to it: per gigabyte stored beyond the quota, per month.
  payg_storage_price_per_gb: 0,
  // Bandwidth plans: per gigabyte of a station's monthly allowance. 0 works it
  // out from the same costs as a listener's price, so that the two kinds of
  // plan cost the same for a listener who never leaves.
  bandwidth_price_per_gb: 0,
  // Per gigabyte sent beyond the allowance, on pay as you go. 0 uses the price above.
  payg_bandwidth_price_per_gb: 0,
});
// A month, for turning a bitrate into data: 30.42 days.
const MONTH_SECONDS = 2628000;
const GB = 1e9;
// Gigabytes one listener who never leaves receives in a month.
const gbPerListenerMonth = (bitrate) => (bitrate * 1000 / 8) * MONTH_SECONDS / GB;
const DEFAULT_BITRATE = 128;

const money = (value) => Math.round(value * 100) / 100;
const rates = async () => ({ ...DEFAULT_RATES, ...((await settings.get('billing')) || {}) });

// The monthly price of one listener at a bitrate, with how it was arrived at.
function listenerRate(r, model, bitrate) {
  const machine = { cores: r.server_vcpus, memory_bytes: r.server_memory_gb * 1024 * costs.MB, port_mbps: r.server_port_mbps };
  // One server doing everything: each listener costs it both the engine's and the proxy's share.
  const capacity = costs.machineCapacity(machine, bitrate, model, { engine: true, proxy: true });
  const cost = capacity.listeners > 0 ? r.server_monthly_cost / capacity.listeners : 0;
  return {
    bitrate_kbps: bitrate,
    listeners_per_server: capacity.listeners,
    limited_by: capacity.limited_by,
    cost_per_listener: Math.round(cost * 1e6) / 1e6,
    price_per_listener: Math.round(cost * (1 + r.margin_percent / 100) * 1e6) / 1e6,
  };
}

// The monthly price of a gigabyte of allowance on a bandwidth plan, and of one beyond it.
function bandwidthRate(r, model, bitrate) {
  const derived = listenerRate(r, model, bitrate).price_per_listener / gbPerListenerMonth(bitrate);
  const included = r.bandwidth_price_per_gb > 0 ? r.bandwidth_price_per_gb : derived;
  return {
    price_per_gb: Math.round(included * 1e6) / 1e6,
    pay_as_you_go_price_per_gb: Math.round((r.payg_bandwidth_price_per_gb > 0 ? r.payg_bandwidth_price_per_gb : included) * 1e6) / 1e6,
    source: r.bandwidth_price_per_gb > 0 ? 'set' : 'worked out from costs',
    // What that much data is, in listening: hours of one listener per gigabyte at this bitrate.
    listener_hours_per_gb: Math.round((GB / (bitrate * 1000 / 8) / 3600) * 100) / 100,
  };
}

// What a number of listeners at a bitrate and an amount of storage would cost per month.
async function quote({ listeners = 0, bandwidth_gb: bandwidthGb = 0, bitrate_kbps: bitrate = DEFAULT_BITRATE, storage_mb: storageMb = 0, discount_percent: discount = 0 }) {
  const [r, model] = await Promise.all([rates(), costs.model()]);
  const rate = listenerRate(r, model, bitrate);
  const data = bandwidthRate(r, model, bitrate);
  const stream = listeners * rate.price_per_listener;
  const bandwidth = bandwidthGb * data.price_per_gb;
  const storage = (storageMb / 1024) * r.storage_price_per_gb;
  return {
    currency: r.currency,
    configured: r.server_monthly_cost > 0 || r.bandwidth_price_per_gb > 0,
    listeners, bandwidth_gb: bandwidthGb, bitrate_kbps: bitrate, storage_mb: storageMb,
    rate,
    bandwidth_rate: data,
    listeners_price: money(stream),
    bandwidth_price: money(bandwidth),
    // What the allowance amounts to: this many listeners, around the clock, for the month.
    bandwidth_covers_listeners_all_month: Math.round((bandwidthGb / gbPerListenerMonth(bitrate)) * 10) / 10,
    storage_price: money(storage),
    discount_percent: discount,
    monthly_total: money((stream + bandwidth + storage) * (1 - discount / 100)),
  };
}

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;

// How a station stands right now, worst first. Being at the limit is a
// matter of the listeners connected at this moment: a station that was full
// half an hour ago and is half empty now is not "at its limit". What it has
// reached before is kept beside it, as history.
function standing(station, usage, daysLeft) {
  if (daysLeft !== null && daysLeft < 0) return 'expired';
  if (usage.bandwidth) {
    // A bandwidth plan stands by how much of the month's data is used, not by listeners.
    if (station.blocked === 'bandwidth') return 'out_of_bandwidth';
    if (usage.bandwidth.over_gb > 0) return station.overage_mode === 'pay_as_you_go' ? 'pay_as_you_go' : 'out_of_bandwidth';
    if (usage.at_limit && usage.at_limit.now) return 'at_limit';
    if (daysLeft !== null && daysLeft <= 7) return 'expiring';
    return usage.bandwidth.percent_used >= 75 ? 'near_limit' : 'ok';
  }
  // Past what the subscription covers, and being charged for it rather than stopped.
  if (usage.pay_as_you_go && usage.pay_as_you_go.active_now && !(usage.at_limit && usage.at_limit.now)) return 'pay_as_you_go';
  if (usage.at_limit ? usage.at_limit.now : usage.percent_of_limit !== null && usage.percent_of_limit >= 100) return 'at_limit';
  if (daysLeft !== null && daysLeft <= 7) return 'expiring';
  if (usage.percent_of_limit !== null && usage.percent_of_limit >= 75) return 'near_limit';
  return 'ok';
}

// What listeners beyond the subscription cost for a number of block-minutes:
// each minute counts the blocks of extra listeners in it, started ones included.
const overageCharge = (r, blockMinutes) => (blockMinutes * r.payg_price_per_block) / r.payg_block_minutes;

const percentOf = (listeners, limit) => (limit > 0 ? Math.round((listeners / limit) * 1000) / 10 : null);

const daysUntil = (date) => (date ? Math.round((Date.parse(`${date}T23:59:59Z`) - Date.now()) / 86400000 - 0.5) : null);

/**
 * The bill for one account: each of its stations with plan, usage and price,
 * its storage, and the total. `user` is a users row.
 */
async function forAccount(user) {
  const [r, model, owned, month] = await Promise.all([
    rates(),
    costs.model(),
    db.query(`SELECT ${stations.COLUMNS} FROM stations WHERE user_id = $1 ORDER BY slug`, [user.id]),
    // Days are UTC days, as everywhere in the statistics.
    db.query(
      `SELECT s.id,
              COALESCE(MAX(d.peak_listeners) FILTER (WHERE d.day >= $2::date), 0)::int AS peak,
              COALESCE(MAX(d.peak_listeners) FILTER (WHERE d.day = (now() AT TIME ZONE 'UTC')::date), 0)::int AS peak_today,
              COALESCE(MAX(d.peak_listeners) FILTER (WHERE d.day > (now() AT TIME ZONE 'UTC')::date - 7), 0)::int AS peak_week,
              COALESCE(SUM(d.listener_seconds) FILTER (WHERE d.day >= $2::date), 0)::bigint AS seconds,
              COALESCE(SUM(d.bytes) FILTER (WHERE d.day >= $2::date), 0)::bigint AS bytes
       FROM stations s LEFT JOIN station_stats_daily d ON d.station_id = s.id AND d.day >= LEAST($2::date, (now() AT TIME ZONE 'UTC')::date - 7)
       WHERE s.user_id = $1 GROUP BY s.id`, [user.id, monthStart()]
    ),
  ]);
  // What stations on pay as you go have had beyond their subscription this month, minute by minute.
  const over = await db.query(
    `SELECT m.station_id, COUNT(*)::int AS minutes, MAX(m.peak_listeners - s.max_listeners)::int AS most,
            SUM(CEIL((m.peak_listeners - s.max_listeners)::numeric / $3))::bigint AS block_minutes,
            MAX(m.recorded_at) AS last_at
     FROM station_stats_minute m JOIN stations s ON s.id = m.station_id
     WHERE s.user_id = $1 AND s.overage_mode = 'pay_as_you_go' AND s.max_listeners > 0 AND m.peak_listeners > s.max_listeners AND m.recorded_at >= $2::date
     GROUP BY m.station_id`, [user.id, monthStart(), r.payg_block_listeners]
  );
  const overBy = new Map(over.rows.map((row) => [row.station_id, row]));
  // How long each limited station has actually been full, from the minute-by-minute record.
  // Full means at the number where listeners are turned away: the limit, or with pay as you go the ceiling.
  const full = await db.query(
    `SELECT m.station_id,
            COUNT(*) FILTER (WHERE m.recorded_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS minutes_today,
            COUNT(*) FILTER (WHERE m.recorded_at >= now() - interval '7 days')::int AS minutes_week,
            COUNT(*)::int AS minutes_month,
            MAX(m.recorded_at) AS last_at
     FROM station_stats_minute m JOIN stations s ON s.id = m.station_id
     WHERE s.user_id = $1 AND s.max_listeners > 0 AND m.recorded_at >= $2::date
       AND m.peak_listeners >= CASE WHEN s.overage_mode = 'pay_as_you_go' THEN COALESCE(s.listener_ceiling, 2147483647) ELSE s.max_listeners END
     GROUP BY m.station_id`, [user.id, monthStart()]
  );
  const fullBy = new Map(full.rows.map((row) => [row.station_id, row]));
  const usageBy = new Map(month.rows.map((row) => [row.id, row]));
  const live = await stations.liveFor(owned.rows.map((row) => row.slug));
  const configured = r.server_monthly_cost > 0;

  const list = owned.rows.map((row) => {
    const now = live.get(row.slug);
    const used = usageBy.get(row.id) || { peak: 0, peak_today: 0, peak_week: 0, seconds: 0, bytes: 0 };
    const peak = Math.max(used.peak, now.listeners);
    const atLimit = fullBy.get(row.id) || { minutes_today: 0, minutes_week: 0, minutes_month: 0, last_at: null };
    const byData = row.plan_type === 'bandwidth';
    const payg = !byData && row.overage_mode === 'pay_as_you_go' && row.max_listeners > 0;
    // Where listeners are turned away: the limit; with pay as you go or a bandwidth plan, the ceiling, if any.
    const stop = byData || payg ? row.listener_ceiling : row.max_listeners;
    const isFull = (byData ? stop !== null : row.max_listeners > 0 && stop !== null) && now.listeners >= stop;
    const extra = overBy.get(row.id) || { minutes: 0, most: 0, block_minutes: 0, last_at: null };
    const detected = (now.stream_format && now.stream_format.bitrate_kbps) || now.bitrate || null;
    const bitrate = row.billing_bitrate_kbps || detected || DEFAULT_BITRATE;
    // An unlimited station is charged for the most listeners it had this month.
    const billed = row.max_listeners > 0 ? row.max_listeners : peak;
    const rate = listenerRate(r, model, bitrate);
    const data = bandwidthRate(r, model, bitrate);
    const allowance = row.bandwidth_gb === null ? 0 : Number(row.bandwidth_gb);
    const usedGb = used.bytes / GB;
    const overGb = byData ? Math.max(0, usedGb - allowance) : 0;
    const calculated = (byData ? allowance * data.price_per_gb : billed * rate.price_per_listener) * (1 - Number(row.discount_percent) / 100);
    // The month so far, carried forward at the same pace.
    const today = new Date();
    const elapsed = (today.getUTCDate() - 1 + (today.getUTCHours() + 1) / 24) / new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
    const override = row.price_override === null ? null : Number(row.price_override);
    // A bandwidth plan has no number of listeners to be measured against.
    const limit = byData ? 0 : row.max_listeners;
    const usage = {
      listeners_now: now.listeners,
      // Of the limit, at this moment. This, not a past peak, is what the status goes by.
      percent_of_limit: percentOf(now.listeners, limit),
      peak_listeners_today: Math.max(used.peak_today, now.listeners),
      peak_listeners_last_7_days: Math.max(used.peak_week, now.listeners),
      peak_listeners_this_month: peak,
      peak_percent_today: percentOf(Math.max(used.peak_today, now.listeners), limit),
      peak_percent_last_7_days: percentOf(Math.max(used.peak_week, now.listeners), limit),
      peak_percent_this_month: percentOf(peak, limit),
      // How long the station has been full, counted in minutes in which it reached its limit.
      at_limit: limit > 0 || (byData && stop !== null) ? {
        now: isFull,
        minutes_today: atLimit.minutes_today,
        minutes_last_7_days: atLimit.minutes_week,
        minutes_this_month: atLimit.minutes_month,
        last_reached_at: isFull ? new Date().toISOString() : atLimit.last_at,
      } : null,
      // A bandwidth plan: the month's data against its allowance. It starts again each calendar month.
      bandwidth: byData ? {
        allowance_gb: allowance,
        used_gb: Math.round(usedGb * 1000) / 1000,
        remaining_gb: Math.round(Math.max(0, allowance - usedGb) * 1000) / 1000,
        over_gb: Math.round(overGb * 1000) / 1000,
        percent_used: allowance > 0 ? Math.round((usedGb / allowance) * 1000) / 10 : null,
        // At the pace of the month so far, what the whole month comes to.
        projected_gb: Math.round((usedGb / Math.max(elapsed, 1 / 744)) * 10) / 10,
        // What is left, in listening at this bitrate.
        remaining_listener_hours: Math.round(Math.max(0, allowance - usedGb) * data.listener_hours_per_gb),
      } : null,
      // Beyond the subscription, for a station on pay as you go.
      pay_as_you_go: payg ? {
        active_now: now.listeners > row.max_listeners,
        extra_listeners_now: Math.max(0, now.listeners - row.max_listeners),
        minutes_this_month: extra.minutes,
        most_extra_listeners: extra.most,
        block_minutes: Number(extra.block_minutes),
        last_at: extra.last_at,
      } : null,
      listener_hours_this_month: Math.round((used.seconds / 3600) * 100) / 100,
      gigabytes_this_month: Math.round((used.bytes / 1e9) * 1000) / 1000,
    };
    const daysLeft = daysUntil(row.subscription_ends_on);
    return {
      station: row.slug,
      name: row.name,
      is_active: row.is_active,
      plan: {
        // 'listeners': pays for a number of listeners at once. 'bandwidth': pays for data, with no listener limit.
        type: row.plan_type,
        bandwidth_gb: byData ? allowance : null,
        price_per_gb: byData ? data.price_per_gb : null,
        pay_as_you_go_price_per_gb: byData ? data.pay_as_you_go_price_per_gb : null,
        max_listeners: byData ? 0 : row.max_listeners,
        listeners_billed: byData ? 0 : billed,
        bitrate_kbps: bitrate,
        bitrate_source: row.billing_bitrate_kbps ? 'set' : detected ? 'detected' : 'default',
        price_per_listener: rate.price_per_listener,
        discount_percent: Number(row.discount_percent),
        price_override: override,
        subscription_ends_on: row.subscription_ends_on,
        days_left: daysLeft,
        // What happens beyond max_listeners: refused, or let in and charged up to the ceiling.
        overage_mode: row.overage_mode,
        listener_ceiling: row.listener_ceiling,
      },
      usage,
      status: standing(row, usage, daysLeft),
      blocked: row.blocked,
      // The subscription: fixed, whatever the month brings.
      monthly_price: configured || override !== null || (byData && r.bandwidth_price_per_gb > 0) ? money(override ?? calculated) : null,
      // On top of it, so far this month: listeners beyond the subscription, or data beyond the allowance.
      pay_as_you_go_charge: payg ? money(overageCharge(r, Number(extra.block_minutes)))
        : byData && row.overage_mode === 'pay_as_you_go' ? money(overGb * data.pay_as_you_go_price_per_gb) : 0,
    };
  });

  const storage = await media.usage(user);
  const quotaGb = storage.quota_bytes === null ? 0 : storage.quota_bytes / 1024 ** 3;
  const storagePrice = configured ? money(quotaGb * r.storage_price_per_gb) : null;
  // Storage beyond the quota, for an account allowed it, is charged on what is stored now.
  const storageExtra = storage.pay_as_you_go ? money((storage.over_quota_bytes / 1024 ** 3) * r.payg_storage_price_per_gb) : 0;
  const extras = list.reduce((sum, s) => sum + s.pay_as_you_go_charge, 0) + storageExtra;
  const subtotal = list.reduce((sum, s) => sum + (s.monthly_price || 0), 0) + (storagePrice || 0);
  const discount = Number(user.discount_percent || 0);
  return {
    user_id: user.id,
    username: user.username,
    email: user.email || null,
    currency: r.currency,
    // false until the administrator has entered what a server costs: prices are then not shown.
    prices_set: configured,
    month: monthStart().slice(0, 7),
    stations: list,
    storage: {
      ...storage,
      percent_used: storage.quota_bytes ? Math.round((storage.used_bytes / storage.quota_bytes) * 1000) / 10 : null,
      monthly_price: storagePrice,
      pay_as_you_go_charge: storageExtra,
    },
    discount_percent: discount,
    // The subscriptions: what the month costs before anything extra.
    monthly_total: configured || list.some((s) => s.monthly_price !== null) ? money(subtotal * (1 - discount / 100)) : null,
    // What has been used beyond them so far this month, and the two together.
    pay_as_you_go_total: money(extras * (1 - discount / 100)),
    total_so_far: configured || list.some((s) => s.monthly_price !== null) || extras > 0 ? money((subtotal + extras) * (1 - discount / 100)) : null,
  };
}

// Takes capped bandwidth plans that have used their month's allowance off the
// air, and puts them back when the month turns or the allowance is raised.
// Run every minute.
async function enforce() {
  const { rows } = await db.query(
    `SELECT s.id, s.user_id, s.slug, s.blocked,
            (s.plan_type = 'bandwidth' AND s.overage_mode = 'capped' AND s.bandwidth_gb IS NOT NULL
             AND COALESCE((SELECT SUM(d.bytes) FROM station_stats_daily d WHERE d.station_id = s.id AND d.day >= $1::date), 0) >= s.bandwidth_gb * 1000000000) AS used_up
     FROM stations s WHERE s.plan_type = 'bandwidth' OR s.blocked IS NOT NULL`, [monthStart()]
  );
  const changed = new Set();
  for (const row of rows) {
    const want = row.used_up ? 'bandwidth' : null;
    if (want === row.blocked) continue;
    await db.query('UPDATE stations SET blocked = $1, updated_at = now() WHERE id = $2', [want, row.id]);
    console.log(`[billing] ${row.slug} ${want ? 'has used its bandwidth for the month and is off the air' : 'is back on the air'}`);
    changed.add(row.user_id);
  }
  for (const userId of changed) await stations.republishUser(userId);
  return changed.size;
}

// Every month on record for an account's stations: the data sent, the most
// listeners at once and the listening hours. A new month starts from nothing;
// the months before it stay.
async function history(userId, months) {
  const { rows } = await db.query(
    `SELECT s.slug AS station, to_char(date_trunc('month', d.day), 'YYYY-MM') AS month,
            SUM(d.bytes)::bigint AS bytes, MAX(d.peak_listeners)::int AS peak, SUM(d.listener_seconds)::bigint AS seconds, SUM(d.sessions)::int AS sessions
     FROM station_stats_daily d JOIN stations s ON s.id = d.station_id
     WHERE s.user_id = $1 AND d.day >= (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => $2 - 1))::date
     GROUP BY s.slug, date_trunc('month', d.day) ORDER BY month DESC, s.slug`, [userId, months]
  );
  return rows.map((row) => ({
    station: row.station, month: row.month,
    gigabytes: Math.round((row.bytes / GB) * 1000) / 1000,
    peak_listeners: row.peak,
    listener_hours: Math.round((row.seconds / 3600) * 100) / 100,
    sessions: row.sessions,
  }));
}

// The rates as the administrator sees them, with worked examples.
async function describeRates() {
  const [r, model] = await Promise.all([rates(), costs.model()]);
  return {
    ...r,
    configured: r.server_monthly_cost > 0,
    per_listener: [64, 96, 128, 192, 320].map((bitrate) => ({ ...listenerRate(r, model, bitrate), bandwidth: bandwidthRate(r, model, bitrate) })),
    // A worked example of pay as you go: 200 listeners over the subscription for 5 minutes.
    pay_as_you_go_example: { extra_listeners: 200, minutes: 5, charge: money(overageCharge(r, Math.ceil(200 / r.payg_block_listeners) * 5)) },
    cost_model: costs.describeModel(model),
  };
}

module.exports = { rates, quote, forAccount, describeRates, listenerRate, bandwidthRate, overageCharge, enforce, history, standing, daysUntil, DEFAULT_RATES };
