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
});
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

// What a number of listeners at a bitrate and an amount of storage would cost per month.
async function quote({ listeners, bitrate_kbps: bitrate = DEFAULT_BITRATE, storage_mb: storageMb = 0, discount_percent: discount = 0 }) {
  const [r, model] = await Promise.all([rates(), costs.model()]);
  const rate = listenerRate(r, model, bitrate);
  const stream = listeners * rate.price_per_listener;
  const storage = (storageMb / 1024) * r.storage_price_per_gb;
  return {
    currency: r.currency,
    configured: r.server_monthly_cost > 0,
    listeners, bitrate_kbps: bitrate, storage_mb: storageMb,
    rate,
    listeners_price: money(stream),
    storage_price: money(storage),
    discount_percent: discount,
    monthly_total: money((stream + storage) * (1 - discount / 100)),
  };
}

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;

// How near a station is to what it is allowed, worst first.
function standing(station, usage, daysLeft) {
  if (daysLeft !== null && daysLeft < 0) return 'expired';
  if (usage.percent_of_limit !== null && usage.percent_of_limit >= 100) return 'at_limit';
  if (daysLeft !== null && daysLeft <= 7) return 'expiring';
  if (usage.percent_of_limit !== null && usage.percent_of_limit >= 75) return 'near_limit';
  return 'ok';
}

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
    db.query(
      `SELECT s.id, COALESCE(MAX(d.peak_listeners), 0)::int AS peak, COALESCE(SUM(d.listener_seconds), 0)::bigint AS seconds, COALESCE(SUM(d.bytes), 0)::bigint AS bytes
       FROM stations s LEFT JOIN station_stats_daily d ON d.station_id = s.id AND d.day >= $2::date
       WHERE s.user_id = $1 GROUP BY s.id`, [user.id, monthStart()]
    ),
  ]);
  const usageBy = new Map(month.rows.map((row) => [row.id, row]));
  const live = await stations.liveFor(owned.rows.map((row) => row.slug));
  const configured = r.server_monthly_cost > 0;

  const list = owned.rows.map((row) => {
    const now = live.get(row.slug);
    const used = usageBy.get(row.id) || { peak: 0, seconds: 0, bytes: 0 };
    const peak = Math.max(used.peak, now.listeners);
    const detected = (now.stream_format && now.stream_format.bitrate_kbps) || now.bitrate || null;
    const bitrate = row.billing_bitrate_kbps || detected || DEFAULT_BITRATE;
    // An unlimited station is charged for the most listeners it had this month.
    const billed = row.max_listeners > 0 ? row.max_listeners : peak;
    const rate = listenerRate(r, model, bitrate);
    const calculated = billed * rate.price_per_listener * (1 - Number(row.discount_percent) / 100);
    const override = row.price_override === null ? null : Number(row.price_override);
    const usage = {
      listeners_now: now.listeners,
      peak_listeners_this_month: peak,
      percent_of_limit: row.max_listeners > 0 ? Math.round((peak / row.max_listeners) * 1000) / 10 : null,
      listener_hours_this_month: Math.round((used.seconds / 3600) * 100) / 100,
      gigabytes_this_month: Math.round((used.bytes / 1e9) * 1000) / 1000,
    };
    const daysLeft = daysUntil(row.subscription_ends_on);
    return {
      station: row.slug,
      name: row.name,
      is_active: row.is_active,
      plan: {
        max_listeners: row.max_listeners,
        listeners_billed: billed,
        bitrate_kbps: bitrate,
        bitrate_source: row.billing_bitrate_kbps ? 'set' : detected ? 'detected' : 'default',
        price_per_listener: rate.price_per_listener,
        discount_percent: Number(row.discount_percent),
        price_override: override,
        subscription_ends_on: row.subscription_ends_on,
        days_left: daysLeft,
      },
      usage,
      status: standing(row, usage, daysLeft),
      monthly_price: configured || override !== null ? money(override ?? calculated) : null,
    };
  });

  const storage = await media.usage(user);
  const quotaGb = storage.quota_bytes === null ? 0 : storage.quota_bytes / 1024 ** 3;
  const storagePrice = configured ? money(quotaGb * r.storage_price_per_gb) : null;
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
    },
    discount_percent: discount,
    monthly_total: configured || list.some((s) => s.monthly_price !== null) ? money(subtotal * (1 - discount / 100)) : null,
  };
}

// The rates as the administrator sees them, with worked examples.
async function describeRates() {
  const [r, model] = await Promise.all([rates(), costs.model()]);
  return {
    ...r,
    configured: r.server_monthly_cost > 0,
    per_listener: [64, 96, 128, 192, 320].map((bitrate) => listenerRate(r, model, bitrate)),
    cost_model: costs.describeModel(model),
  };
}

module.exports = { rates, quote, forAccount, describeRates, listenerRate, standing, daysUntil, DEFAULT_RATES };
