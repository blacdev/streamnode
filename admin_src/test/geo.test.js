const test = require('node:test');
const assert = require('node:assert');
const v = require('../src/validate');
const geo = require('../src/geo');

const fields = (fn) => {
  try {
    fn();
    return [];
  } catch (err) {
    return err.details.map((d) => d.field);
  }
};

test('players are sorted into kinds of device', () => {
  const cases = {
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)': 'mobile',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari': 'mobile',
    'Mozilla/5.0 (iPad; CPU OS 17_0)': 'tablet',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120': 'desktop',
    'VLC/3.0.20 LibVLC/3.0.20': 'player app',
    'Lavf/60.3.100': 'player app',
    'Sonos/80.1-55014 (ZPS1)': 'smart speaker',
    'AlexaMediaPlayer/2.1.4676.0 (Linux;Android 5.1.1)': 'smart speaker',
    'Roku/DVP-12.0 (12.0.0.4182-88)': 'tv',
    '': 'unknown',
    'SomethingElse/1.0': 'other',
  };
  for (const [ua, kind] of Object.entries(cases)) assert.strictEqual(geo.deviceOf(ua), kind, ua);
});

test('a finished stream is read from the HAProxy log line', () => {
  const line = '<142>Oct 15 14:14:50 haproxy[3907]: 10.0.0.9:35878 [15/Oct/2026:14:14:50.572] network_ingress streaming_engine_backend/local 0/0/1/2/1830500 200 2290000 - - ---- 3/3/1/1/0 0/0 {} "GET /jazz-fm HTTP/1.1" audience="jazz-fm","NG","VLC/3.0.20 LibVLC/3.0.20"';
  assert.deepStrictEqual(geo.parseLogLine(line), { slug: 'jazz-fm', country: 'NG', device: 'player app', seconds: 1831, bytes: 2290000 });
  // Refused (451), not served by an engine, unknown country, management requests.
  assert.strictEqual(geo.parseLogLine(line.replace(' 200 ', ' 451 ').replace('streaming_engine_backend/local', 'network_ingress/<NOSRV>')), null);
  assert.strictEqual(geo.parseLogLine(line.replace('streaming_engine_backend/local', 'management_node_backend/admin_srv')), null);
  assert.strictEqual(geo.parseLogLine(line.replace('"NG"', '"ZZ"')).country, 'ZZ');
  assert.strictEqual(geo.parseLogLine(line.replace('"NG"', '"-"')).country, 'ZZ');
  assert.strictEqual(geo.parseLogLine('not a log line'), null);
});

test('rules become map entries; allow-lists wait for the country database', () => {
  const stations = [
    { slug: 'a', geo_mode: 'block', geo_countries: ['GB', 'US'] },
    { slug: 'b', geo_mode: 'allow', geo_countries: ['NG'] },
    { slug: 'c', geo_mode: 'off', geo_countries: ['FR'] },
  ];
  assert.deepStrictEqual(geo.ruleEntries(stations, { countriesLoaded: true }), { blocked: ['a|GB', 'a|US'], allowlist: ['b'], allowed: ['b|NG'] });
  // Without countries every listener is "ZZ": an allow-list then would turn everyone away.
  assert.deepStrictEqual(geo.ruleEntries(stations, { countriesLoaded: false }), { blocked: ['a|GB', 'a|US'], allowlist: [], allowed: [] });
});

test('address ranges become the fewest exact CIDR blocks', () => {
  assert.deepStrictEqual(geo.ipv4RangeToCidrs('1.0.0.0', '1.0.0.255'), ['1.0.0.0/24']);
  assert.deepStrictEqual(geo.ipv4RangeToCidrs('1.0.0.1', '1.0.0.6'), ['1.0.0.1/32', '1.0.0.2/31', '1.0.0.4/31', '1.0.0.6/32']);
  assert.deepStrictEqual(geo.ipv4RangeToCidrs('0.0.0.0', '255.255.255.255'), ['0.0.0.0/0']);
  assert.deepStrictEqual(geo.ipv6RangeToCidrs('2001:db8::', '2001:db8::ffff'), ['2001:db8:0:0:0:0:0:0/112']);
  assert.deepStrictEqual(geo.ipv6RangeToCidrs('::1', '::1'), ['0:0:0:0:0:0:0:1/128']);
  const lines = geo.csvToMapLines('"1.0.0.0","1.0.0.255","AU"\n2001:db8::,2001:db8::ffff,NG\nbad,row,\n1.0.1.0,1.0.1.255,ZZZ\n');
  assert.deepStrictEqual(lines, ['1.0.0.0/24 AU', '2001:db8:0:0:0:0:0:0/112 NG']);
});

test('the database address names the month', () => {
  assert.strictEqual(geo.databaseUrl('https://x/dbip-country-lite-{YYYY}-{MM}.csv.gz', new Date(Date.UTC(2026, 0, 5))), 'https://x/dbip-country-lite-2026-01.csv.gz');
});

test('station country rules are validated', () => {
  assert.deepStrictEqual(v.parseStation({ geo_mode: 'block', geo_countries: ['ng', 'GB', 'NG'] }, { partial: true }), { geo_mode: 'block', geo_countries: ['GB', 'NG'] });
  assert.deepStrictEqual(fields(() => v.parseStation({ geo_mode: 'everywhere', geo_countries: ['Nigeria'] }, { partial: true })), ['geo_mode', 'geo_countries']);
  assert.deepStrictEqual(fields(() => v.parseSettings({ geo_database_url: 'ftp://x/{YYYY}.csv' })), ['geo_database_url']);
});

test('without GEO_ENABLED nothing is advertised and rules are reported inactive', () => {
  assert.strictEqual(geo.enabled(), false);
  assert.deepStrictEqual(geo.capabilities(), []);
  assert.strictEqual(geo.statusFor({ geo_mode: 'off' }), 'off');
  assert.match(geo.statusFor({ geo_mode: 'block' }), /GEO_ENABLED/);
});
