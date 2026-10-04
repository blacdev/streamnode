// Tells station owners, by email, when they are approaching what they are
// allowed: listeners against a station's limit, uploaded audio against the
// account's storage, and the days left on a station's subscription. Notices
// come more often the nearer the limit is. Nothing is sent to an account
// without an email address, or while email is not set up.

//
// How much mail that makes is the administrator's to decide: the levels, a
// minimum number of days between notices about the same thing, and whether
// notices go out by themselves at all or only when asked for through the API.

const db = require('./db');
const billing = require('./billing');
const mail = require('./mail');
const settings = require('./settings');

const DEFAULTS = Object.freeze({ automatic: true, levels: [50, 75, 90, 100], min_days_between: 1 });
const preferences = async () => ({ ...DEFAULTS, ...((await settings.get('notices')) || {}) });

// How often a notice at a level may repeat: the nearer the limit, the oftener.
const levelsFrom = (percents) => [...percents].sort((a, b) => b - a).map((percent) => ({ percent, every: percent >= 90 ? 'day' : percent >= 75 ? 'week' : 'month' }));
const LEVELS = levelsFrom(DEFAULTS.levels);
// Days before a subscription ends on which a notice goes out (0 is the last day, -1 the day after).
const DAYS_BEFORE_END = [30, 14, 7, 3, 2, 1, 0, -1];

function period(every, now = new Date()) {
  const iso = now.toISOString();
  if (every === 'month') return iso.slice(0, 7);
  if (every === 'day') return iso.slice(0, 10);
  // Weeks are counted from the first day of the year; good enough to space notices out.
  const week = Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 1)) / (7 * 86400000));
  return `${now.getUTCFullYear()}-w${String(week).padStart(2, '0')}`;
}

// The highest level reached, or null below the first.
const levelFor = (percent, levels = LEVELS) => (percent === null ? null : levels.find((level) => percent >= level.percent) || null);

const money = (amount, currency) => `${currency} ${Number(amount).toFixed(2)}`;

/**
 * The notices an account's present state calls for. Pure: `bill` is what
 * billing.forAccount returns. Each has a key that makes it unique in its period.
 */
function due(bill, now = new Date(), levels = LEVELS) {
  const out = [];
  for (const s of bill.stations) {
    const data = s.usage.bandwidth;
    if (data) {
      // A bandwidth plan is used up through the month and starts again with the next,
      // so each of its notices is sent once in a month.
      const month = period('month', now);
      const figures = `${s.name} (/${s.station}) has sent ${data.used_gb.toFixed(1)} GB of the ${data.allowance_gb} GB its plan covers this month.`;
      if (data.over_gb > 0 && s.plan.overage_mode === 'pay_as_you_go') {
        out.push({
          station: s.station, kind: 'pay_as_you_go', threshold: 0, period: month,
          subject: `${s.name} has used its bandwidth and is on pay as you go`,
          text: `${figures}\n\nIt stays on the air, and the data beyond the plan is charged as it is used: ${data.over_gb.toFixed(1)} GB so far, ${money(s.pay_as_you_go_charge, bill.currency)}, on top of the subscription. The allowance starts again with the new month. To have more covered by the plan, ask for a larger one.`,
        });
      } else if (data.over_gb > 0 || s.blocked === 'bandwidth') {
        out.push({
          station: s.station, kind: 'bandwidth', threshold: 100, period: month,
          subject: `${s.name} has used its bandwidth for the month and is off the air`,
          text: `${figures}\n\nThe station is off the air until the new month begins, when the allowance starts again. To bring it back sooner, ask for a larger plan or for pay as you go.`,
        });
      } else {
        const level = levelFor(data.percent_used, levels.filter((candidate) => candidate.percent < 100));
        if (level) {
          out.push({
            station: s.station, kind: 'bandwidth', threshold: level.percent, period: month,
            subject: `${s.name} has used ${level.percent}% of its bandwidth for the month`,
            text: `${figures} ${data.remaining_gb.toFixed(1)} GB is left, about ${data.remaining_listener_hours.toLocaleString('en')} hours of listening. At the pace of the month so far it would reach ${data.projected_gb.toFixed(0)} GB by the end of the month.\n\n${s.plan.overage_mode === 'pay_as_you_go' ? 'When the plan is used up the station stays on the air and the extra is charged as it is used.' : 'When the plan is used up the station goes off the air until the new month. To avoid that, ask for a larger plan or for pay as you go.'}`,
          });
        }
      }
    }
    const extra = s.usage.pay_as_you_go;
    // Beyond its subscription and being charged for it: said once on a day it happens.
    if (extra && (extra.active_now || (extra.last_at && new Date(extra.last_at).toISOString().slice(0, 10) === now.toISOString().slice(0, 10)))) {
      out.push({
        station: s.station, kind: 'pay_as_you_go', threshold: 0, period: period('day', now),
        subject: `${s.name} is beyond its subscription and on pay as you go`,
        text: [
          `${s.name} (/${s.station}) has had more listeners than the ${s.plan.max_listeners} its subscription covers: up to ${extra.most_extra_listeners} more, for ${extra.minutes_this_month} minute${extra.minutes_this_month === 1 ? '' : 's'} so far this month. Right now it has ${s.usage.listeners_now}.`,
          `The extra listeners are let in and charged as they go. So far this month that comes to ${money(s.pay_as_you_go_charge, bill.currency)}, on top of the subscription.${s.plan.listener_ceiling ? ` No more than ${s.plan.listener_ceiling} listeners are let in at once.` : ''}`,
          'To have them covered by the subscription instead, ask for a higher listener limit.',
        ].join('\n\n'),
      });
    }
    // Each level is judged over the span its notice repeats in, so that a
    // notice goes out for what happened in that span and not for something
    // further back: reaching the limit once does not mean a notice every day.
    // A station on pay as you go has no limit to reach at 100%: that is the notice above,
    // and on a day it goes out there is nothing to add about approaching the number.
    const beyond = out.length > 0 && out[out.length - 1].station === s.station;
    // (A bandwidth plan has no listener limit to approach.)
    const level = beyond || data ? null : levels.filter((candidate) => !extra || candidate.percent < 100).find((candidate) => {
      const reached = { day: s.usage.peak_percent_today, week: s.usage.peak_percent_last_7_days, month: s.usage.peak_percent_this_month }[candidate.every];
      return reached !== null && reached !== undefined && reached >= candidate.percent;
    });
    if (level) {
      const [peak, span] = {
        day: [s.usage.peak_listeners_today, 'today'],
        week: [s.usage.peak_listeners_last_7_days, 'in the last seven days'],
        month: [s.usage.peak_listeners_this_month, 'this month'],
      }[level.every];
      const full = s.usage.at_limit && s.usage.at_limit.minutes_today;
      out.push({
        station: s.station, kind: 'listeners', threshold: level.percent, period: period(level.every, now),
        subject: level.percent >= 100
          ? `${s.name} has reached its listener limit`
          : `${s.name} has reached ${level.percent}% of its listener limit`,
        text: [
          `${s.name} (/${s.station}) has had up to ${peak} listeners at once ${span}. Its limit is ${s.plan.max_listeners}.${level.percent >= 100 && full ? ` It has been full for about ${full} minute${full === 1 ? '' : 's'} today.` : ''} Right now it has ${s.usage.listeners_now}.`,
          level.percent >= 100
            ? 'Listeners beyond the limit are turned away until others leave. To allow more, ask for the limit to be raised.'
            : 'When the limit is reached, further listeners are turned away until others leave. To allow more, ask for the limit to be raised.',
        ].join('\n\n'),
      });
    }
    const left = s.plan.days_left;
    if (left !== null && DAYS_BEFORE_END.includes(left)) {
      out.push({
        station: s.station, kind: 'subscription', threshold: left, period: s.plan.subscription_ends_on,
        subject: left < 0 ? `The subscription for ${s.name} has ended`
          : left === 0 ? `The subscription for ${s.name} ends today`
            : `The subscription for ${s.name} ends in ${left} day${left === 1 ? '' : 's'}`,
        text: `The subscription for ${s.name} (/${s.station}) ${left < 0 ? 'ended' : 'ends'} on ${s.plan.subscription_ends_on}. Renew it to keep the station on air.`,
      });
    }
  }
  if (bill.storage.pay_as_you_go && bill.storage.over_quota_bytes > 0) {
    out.push({
      station: null, kind: 'pay_as_you_go', threshold: 0, period: period('week', now),
      subject: 'Your audio storage is beyond its quota and on pay as you go',
      text: `Your account is storing ${(bill.storage.used_bytes / 1024 ** 2).toFixed(1)} MB of audio and its quota is ${(bill.storage.quota_bytes / 1024 ** 2).toFixed(0)} MB. The ${(bill.storage.over_quota_bytes / 1024 ** 2).toFixed(1)} MB beyond the quota is charged: ${money(bill.storage.pay_as_you_go_charge, bill.currency)} a month at present. Delete files you no longer need to bring it down.`,
    });
  }
  const storage = bill.storage.pay_as_you_go ? null : levelFor(bill.storage.percent_used, levels);
  if (storage) {
    out.push({
      station: null, kind: 'storage', threshold: storage.percent, period: period(storage.every, now),
      subject: storage.percent >= 100 ? 'Your audio storage is full' : `Your audio storage is ${storage.percent}% full`,
      text: `Your account is using ${(bill.storage.used_bytes / 1024 ** 2).toFixed(1)} MB of its ${(bill.storage.quota_bytes / 1024 ** 2).toFixed(0)} MB of storage for idents and fallback audio. Delete files you no longer need, or ask for more storage.`,
    });
  }
  return out;
}

const ACCOUNT = 'id, username, role, email, storage_quota_mb, discount_percent';

let running = false;

/**
 * Looks at every account with an email address and sends what is due and not
 * yet sent. The timer calls it plainly and it does nothing while automatic
 * notices are switched off; `force` is a request through the API to send
 * them all the same.
 */
async function run({ force = false } = {}) {
  const prefs = await preferences();
  if (!force && !prefs.automatic) return { sent: 0, automatic: false };
  if (running || !(await mail.configured())) return { sent: 0 };
  running = true;
  let sent = 0;
  const levels = levelsFrom(prefs.levels);
  try {
    const { rows: users } = await db.query(
      `SELECT ${ACCOUNT} FROM users WHERE is_active AND email IS NOT NULL AND email <> ''`
    );
    const ids = new Map();
    for (const user of users) {
      const bill = await billing.forAccount(user);
      for (const notice of due(bill, new Date(), levels)) {
        let stationId = 0;
        if (notice.station) {
          if (!ids.has(notice.station)) ids.set(notice.station, (await db.query('SELECT id FROM stations WHERE slug = $1', [notice.station])).rows[0].id);
          stationId = ids.get(notice.station);
        }
        // No more than one notice about the same thing in the days the administrator has set.
        // Reminders of a subscription's end are dated, and are left alone.
        if (prefs.min_days_between > 0 && notice.kind !== 'subscription') {
          const recent = await db.query(
            "SELECT 1 FROM notifications WHERE user_id = $1 AND station_id = $2 AND kind = $3 AND sent_at > now() - make_interval(days => $4) LIMIT 1",
            [user.id, stationId, notice.kind, prefs.min_days_between]
          );
          if (recent.rowCount) continue;
        }
        // Recording it first is what stops two runs sending the same notice.
        const claimed = await db.query(
          `INSERT INTO notifications (user_id, station_id, kind, threshold, period, recipient, subject) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, station_id, kind, threshold, period) DO NOTHING RETURNING id`,
          [user.id, stationId, notice.kind, notice.threshold, notice.period, user.email, notice.subject]
        );
        if (!claimed.rows[0]) continue;
        try {
          await mail.send({ to: user.email, subject: notice.subject, text: `Hello ${user.username},\n\n${notice.text}\n` });
          sent += 1;
        } catch (err) {
          // Not sent: forget it, so that the next run tries again.
          await db.query('DELETE FROM notifications WHERE id = $1', [claimed.rows[0].id]);
          console.error(`[notify] could not email ${user.email}: ${err.message}`);
          return { sent, error: err.message };
        }
      }
    }
    return { sent };
  } finally {
    running = false;
  }
}

/**
 * Sends one account a summary of where it stands now: every station against
 * what its subscription covers, storage, and what the month comes to. Sent
 * when asked for, whatever the automatic notices are set to.
 */
async function sendSummary(userId) {
  const { rows } = await db.query(`SELECT ${ACCOUNT} FROM users WHERE id = $1`, [userId]);
  const user = rows[0];
  if (!user) return null;
  if (!user.email) return { sent: false, reason: 'This account has no email address.' };
  const bill = await billing.forAccount(user);
  const lines = bill.stations.map((s) => {
    const limit = s.usage.bandwidth ? `${s.usage.bandwidth.used_gb.toFixed(1)} of ${s.usage.bandwidth.allowance_gb} GB used this month, ${s.usage.listeners_now} listeners now`
      : s.plan.max_listeners ? `${s.usage.listeners_now} of ${s.plan.max_listeners} listeners now, most this month ${s.usage.peak_listeners_this_month}` : `${s.usage.listeners_now} listeners now, no limit`;
    const extra = s.usage.pay_as_you_go && s.usage.pay_as_you_go.minutes_this_month
      ? `; beyond its subscription for ${s.usage.pay_as_you_go.minutes_this_month} minutes this month (${money(s.pay_as_you_go_charge, bill.currency)} so far)`
      : s.usage.bandwidth && s.pay_as_you_go_charge > 0 ? `; ${s.usage.bandwidth.over_gb.toFixed(1)} GB beyond its plan (${money(s.pay_as_you_go_charge, bill.currency)} so far)`
        : s.blocked === 'bandwidth' ? '; off the air until the new month' : '';
    const ends = s.plan.subscription_ends_on ? `; subscription ends ${s.plan.subscription_ends_on}` : '';
    const price = s.monthly_price === null ? '' : `; ${money(s.monthly_price, bill.currency)} a month`;
    return `- ${s.name} (/${s.station}): ${limit}${extra}${ends}${price}`;
  });
  const storage = bill.storage.quota_bytes === null ? `${(bill.storage.used_bytes / 1024 ** 2).toFixed(1)} MB used`
    : `${(bill.storage.used_bytes / 1024 ** 2).toFixed(1)} MB of ${(bill.storage.quota_bytes / 1024 ** 2).toFixed(0)} MB used`;
  const total = bill.total_so_far === null ? '' : `\n\nThis month so far: ${money(bill.total_so_far, bill.currency)}${bill.pay_as_you_go_total > 0 ? ` (${money(bill.monthly_total, bill.currency)} subscriptions, ${money(bill.pay_as_you_go_total, bill.currency)} pay as you go)` : ''}.`;
  const subject = 'Your stations: where they stand';
  await mail.send({ to: user.email, subject, text: `Hello ${user.username},\n\n${lines.join('\n') || 'You have no stations.'}\n\nAudio storage: ${storage}.${total}\n` });
  await db.query(
    "INSERT INTO notifications (user_id, station_id, kind, threshold, period, recipient, subject) VALUES ($1, 0, 'summary', 0, $2, $3, $4) ON CONFLICT DO NOTHING",
    [user.id, new Date().toISOString().slice(0, 19), user.email, subject]
  );
  return { sent: true, to: user.email };
}

module.exports = { run, due, sendSummary, preferences, period, levelFor, levelsFrom, LEVELS, DAYS_BEFORE_END, DEFAULTS };
