const test = require('node:test');
const assert = require('node:assert');
const fallbacks = require('../src/fallbacks');

const errorsOf = (value) => {
  const errors = [];
  const out = fallbacks.parse(value, (field, message) => errors.push({ field, message }));
  return { out, fields: errors.map((e) => e.field) };
};

test('a schedule is a list of files with their days', () => {
  assert.deepStrictEqual(errorsOf([{ file_id: 3, days: ['Sun', 'sat', 'saturday'] }]).out, [{ file_id: 3, days: ['sat', 'sun'] }]);
  assert.deepStrictEqual(errorsOf(null).out, [], 'null clears it');
  assert.deepStrictEqual(errorsOf([{ file_id: 3, days: [] }]).fields, ['fallback_schedule[0].days']);
  assert.deepStrictEqual(errorsOf([{ file_id: 'x', days: ['mon'] }]).fields, ['fallback_schedule[0].file_id']);
  assert.deepStrictEqual(errorsOf([{ file_id: 3, days: ['someday'] }]).fields, ['fallback_schedule[0].days']);
  assert.deepStrictEqual(errorsOf('mon').fields, ['fallback_schedule']);
  assert.deepStrictEqual(errorsOf(Array(51).fill({ file_id: 1, days: ['mon'] })).fields, ['fallback_schedule']);
});

test('time zones are checked by name', () => {
  assert.ok(fallbacks.validZone('Africa/Lagos'));
  assert.ok(fallbacks.validZone('UTC'));
  assert.ok(!fallbacks.validZone('Mars/Olympus'));
  assert.ok(!fallbacks.validZone(''));
});

test('the day is counted in the station\'s time zone', () => {
  // Saturday 23:30 UTC: still Saturday in London and New York, already Sunday in Tokyo.
  const at = new Date('2026-11-07T23:30:00Z');
  assert.strictEqual(fallbacks.dayIn('Europe/London', at), 'sat');
  assert.strictEqual(fallbacks.dayIn('Asia/Tokyo', at), 'sun');
  assert.strictEqual(fallbacks.dayIn('America/New_York', at), 'sat');
  assert.strictEqual(fallbacks.dayIn('not a zone', at), 'sat', 'an unknown zone counts as UTC');
});

test('scheduled files play instead of the everyday one on their days', () => {
  const station = {
    timezone: 'Africa/Lagos',
    fallback_file_id: 1,
    fallback_schedule: [
      { file_id: 7, days: ['sat', 'sun'] },
      { file_id: 8, days: ['sun'] },
      { file_id: 7, days: ['sun'] },
    ],
  };
  const sunday = new Date('2026-11-08T12:00:00Z');
  const saturday = new Date('2026-11-07T12:00:00Z');
  const monday = new Date('2026-11-09T12:00:00Z');
  assert.deepStrictEqual(fallbacks.today(station, sunday), [7, 8], 'in order, each file once');
  assert.deepStrictEqual(fallbacks.today(station, saturday), [7]);
  assert.deepStrictEqual(fallbacks.today(station, monday), [1], 'the everyday file');
  assert.deepStrictEqual(fallbacks.today({ ...station, fallback_file_id: null }, monday), [], 'nothing for today');
  assert.deepStrictEqual(fallbacks.today({ fallback_file_id: 4 }, monday), [4], 'a station without a schedule');
});
