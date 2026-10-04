// Tells station owners, by email, when they are approaching what they are
// allowed: listeners against a station's limit, uploaded audio against the
// account's storage, and the days left on a station's subscription. Notices
// come more often the nearer the limit is. Nothing is sent to an account
// without an email address, or while email is not set up.

const db = require('./db');
const billing = require('./billing');
const mail = require('./mail');

// How full, and how often a notice at that level may repeat.
const LEVELS = [
  { percent: 100, every: 'day' },
  { percent: 90, every: 'day' },
  { percent: 75, every: 'week' },
  { percent: 50, every: 'month' },
];
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
const levelFor = (percent) => (percent === null ? null : LEVELS.find((level) => percent >= level.percent) || null);

/**
 * The notices an account's present state calls for. Pure: `bill` is what
 * billing.forAccount returns. Each has a key that makes it unique in its period.
 */
function due(bill, now = new Date()) {
  const out = [];
  for (const s of bill.stations) {
    // Each level is judged over the span its notice repeats in, so that a
    // notice goes out for what happened in that span and not for something
    // further back: reaching the limit once does not mean a notice every day.
    const level = LEVELS.find((candidate) => {
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
  const storage = levelFor(bill.storage.percent_used);
  if (storage) {
    out.push({
      station: null, kind: 'storage', threshold: storage.percent, period: period(storage.every, now),
      subject: storage.percent >= 100 ? 'Your audio storage is full' : `Your audio storage is ${storage.percent}% full`,
      text: `Your account is using ${(bill.storage.used_bytes / 1024 ** 2).toFixed(1)} MB of its ${(bill.storage.quota_bytes / 1024 ** 2).toFixed(0)} MB of storage for idents and fallback audio. Delete files you no longer need, or ask for more storage.`,
    });
  }
  return out;
}

let running = false;

// Looks at every account with an email address and sends what is due and not yet sent.
async function run() {
  if (running || !(await mail.configured())) return { sent: 0 };
  running = true;
  let sent = 0;
  try {
    const { rows: users } = await db.query(
      "SELECT id, username, role, email, storage_quota_mb, discount_percent FROM users WHERE is_active AND email IS NOT NULL AND email <> ''"
    );
    const ids = new Map();
    for (const user of users) {
      const bill = await billing.forAccount(user);
      for (const notice of due(bill)) {
        let stationId = 0;
        if (notice.station) {
          if (!ids.has(notice.station)) ids.set(notice.station, (await db.query('SELECT id FROM stations WHERE slug = $1', [notice.station])).rows[0].id);
          stationId = ids.get(notice.station);
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

module.exports = { run, due, period, levelFor, LEVELS, DAYS_BEFORE_END };
