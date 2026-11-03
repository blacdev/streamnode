// Fallback audio by day of the week.
//
// A station's `fallback_file_id` is its everyday fallback, as before. Its
// `fallback_schedule` adds more files, each for the days of the week it is
// chosen for. On a day that has scheduled files, those are what plays, one
// after the other in their order, round and round; on any other day the
// everyday fallback plays. Days are counted in the station's `timezone`.
//
// The engines are not told about days: they are given the playlist for today
// (`fallback_list` in the station's profile), which the management service
// works out again every minute, so a new day's files take over by themselves.

const db = require('./db');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_ENTRIES = 50;

// Whether a time zone name is one this system knows (IANA names such as "Africa/Lagos").
function validZone(name) {
  if (typeof name !== 'string' || !name || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

// Checks `fallback_schedule` as given in a request. Returns [{ file_id, days }]
// with days as names in week order, or adds to `fail` and returns undefined.
function parse(value, fail) {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    fail('fallback_schedule', `must be a list of at most ${MAX_ENTRIES} entries like {"file_id": 12, "days": ["sat", "sun"]}`);
    return undefined;
  }
  const out = [];
  let ok = true;
  value.forEach((entry, i) => {
    const field = `fallback_schedule[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(field, 'must be an object with "file_id" and "days"');
      ok = false;
      return;
    }
    if (!Number.isInteger(entry.file_id) || entry.file_id < 1) {
      fail(`${field}.file_id`, 'must be the id of an uploaded file');
      ok = false;
    }
    const days = Array.isArray(entry.days) ? entry.days.map((d) => (typeof d === 'string' ? d.trim().toLowerCase().slice(0, 3) : d)) : null;
    if (!days || !days.length || days.some((d) => !DAYS.includes(d))) {
      fail(`${field}.days`, `must list one or more days: ${DAYS.join(', ')}`);
      ok = false;
      return;
    }
    out.push({ file_id: entry.file_id, days: DAYS.filter((d) => days.includes(d)) });
  });
  return ok ? out : undefined;
}

// The schedules of the given station rows, set on each as `fallback_schedule`.
async function attach(rows) {
  const pending = rows.filter((row) => row.fallback_schedule === undefined);
  if (!pending.length) return rows;
  const { rows: entries } = await db.query(
    'SELECT station_id, file_id, days FROM station_fallbacks WHERE station_id = ANY($1) ORDER BY station_id, position, id',
    [pending.map((row) => row.id)]
  );
  for (const row of pending) row.fallback_schedule = [];
  const byId = new Map(pending.map((row) => [row.id, row]));
  for (const entry of entries) {
    byId.get(entry.station_id).fallback_schedule.push({ file_id: entry.file_id, days: entry.days.map((d) => DAYS[d - 1]) });
  }
  return rows;
}

// Replaces a station's schedule. `client` may be a transaction's.
async function save(stationId, schedule, client = db) {
  await client.query('DELETE FROM station_fallbacks WHERE station_id = $1', [stationId]);
  for (const [position, entry] of schedule.entries()) {
    await client.query(
      'INSERT INTO station_fallbacks (station_id, file_id, days, position) VALUES ($1, $2, $3, $4)',
      [stationId, entry.file_id, entry.days.map((d) => DAYS.indexOf(d) + 1), position]
    );
  }
}

// The day of the week, as a name, at `now` in `zone`.
function dayIn(zone, now = new Date()) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: validZone(zone) ? zone : 'UTC', weekday: 'short' }).format(now);
  return name.slice(0, 3).toLowerCase();
}

// The files to play as fallback audio today, in order: those scheduled for
// today, or else the everyday fallback. File ids; usability is the caller's.
function today(row, now = new Date()) {
  const day = dayIn(row.timezone, now);
  const scheduled = (row.fallback_schedule || []).filter((entry) => entry.days.includes(day)).map((entry) => entry.file_id);
  if (scheduled.length) return [...new Set(scheduled)];
  return row.fallback_file_id ? [row.fallback_file_id] : [];
}

module.exports = { DAYS, MAX_ENTRIES, validZone, parse, attach, save, dayIn, today };
