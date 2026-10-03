const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const audio = require('../src/audio');
const v = require('../src/validate');

// MPEG-1 Layer III frames at 44.1 kHz: 0x70 is 96 kbps (313 bytes), 0x90 is 128 kbps (417 bytes).
const mp3Frame = (bitrateByte = 0x70, mono = false) => {
  const length = bitrateByte === 0x70 ? 313 : 417;
  const frame = Buffer.alloc(length, 0x55);
  frame.set([0xff, 0xfb, bitrateByte, mono ? 0xc0 : 0x00]);
  return frame;
};
const mp3 = (count, bitrateByte, mono) => Buffer.concat(Array.from({ length: count }, () => mp3Frame(bitrateByte, mono)));

// ADTS AAC-LC, 44.1 kHz, stereo, 200-byte frames.
const aacFrame = () => {
  const frame = Buffer.alloc(200, 0x55);
  frame.set([0xff, 0xf1, 0x50, 0x80 | (200 >> 11), (200 >> 3) & 0xff, ((200 & 7) << 5) | 0x1f, 0xfc]);
  return frame;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-audio-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const analyse = (buffer) => {
  const file = path.join(dir, String(n++));
  fs.writeFileSync(file, buffer);
  return audio.analyse(file);
};

const STREAM = { codec: 'mp3', sample_rate: 44100, channels: 2, bitrate_kbps: 96 };

test('reads a constant-bitrate MP3', async () => {
  const info = await analyse(mp3(100));
  assert.deepStrictEqual(
    { ...info },
    { codec: 'mp3', sample_rate: 44100, channels: 2, bitrate_kbps: 96, constant_bitrate: true, duration_seconds: 2.61, audio_offset: 0, audio_bytes: 31300 }
  );
  assert.deepStrictEqual(audio.mismatches(info, STREAM), []);
});

test('leaves tags out of the audio', async () => {
  const id3 = Buffer.alloc(10 + 300, 0xff); // a tag full of bytes that look like frame headers
  id3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x02, 0x2c]);
  const tail = Buffer.alloc(128, 0x20);
  tail.write('TAG');
  const info = await analyse(Buffer.concat([id3, mp3(50), tail]));
  assert.strictEqual(info.audio_offset, 310);
  assert.strictEqual(info.audio_bytes, 50 * 313);
});

test('reads ADTS AAC', async () => {
  const info = await analyse(Buffer.concat(Array.from({ length: 80 }, aacFrame)));
  assert.strictEqual(info.codec, 'aac');
  assert.strictEqual(info.sample_rate, 44100);
  assert.strictEqual(info.channels, 2);
  assert.strictEqual(info.audio_bytes, 16000);
  assert.strictEqual(audio.mismatches(info, STREAM)[0], 'it is AAC and the stream is MP3');
  assert.deepStrictEqual(audio.mismatches(info, { codec: 'aac', sample_rate: 44100, channels: 2, bitrate_kbps: 64 }), []);
});

test('says what differs from the stream', async () => {
  assert.deepStrictEqual(audio.mismatches(await analyse(mp3(50, 0x90)), STREAM), ["its bitrate is 128 kbps and the stream's is 96 kbps"]);
  assert.deepStrictEqual(audio.mismatches(await analyse(mp3(50, 0x70, true)), STREAM), ['it is mono and the stream is stereo']);
  const variable = await analyse(Buffer.concat([mp3(20), mp3(20, 0x90), mp3(20)]));
  assert.strictEqual(variable.constant_bitrate, false);
  assert.deepStrictEqual(audio.mismatches(variable, STREAM), ['it uses a variable bitrate']);
  assert.strictEqual(audio.target(STREAM), 'MP3, 96 kbps constant bitrate, 44.1 kHz, stereo');
});

test('refuses what is not MP3 or AAC, with advice', async () => {
  const wav = Buffer.alloc(400);
  wav.write('RIFF');
  const m4a = Buffer.alloc(400);
  m4a.write('ftypM4A ', 4);
  await assert.rejects(analyse(wav), /WAV file.*Export it as MP3 or AAC/);
  await assert.rejects(analyse(m4a), /MP4\/M4A file.*\.aac/);
  await assert.rejects(analyse(Buffer.alloc(5000, 0x41)), /No MP3 or AAC audio/);
  await assert.rejects(analyse(Buffer.alloc(10)), /too small/);
});

test('station failover fields are validated', () => {
  const base = { name: 'Jazz', slug: 'jazz', primary_url: 'https://a.example.com/live' };
  const out = v.parseStation({ ...base, failover_delay_secs: 10, silence_detection: false, ident_file_id: 3, fallback_file_id: null });
  assert.deepStrictEqual(
    [out.failover_delay_secs, out.silence_detection, out.ident_file_id, out.fallback_file_id],
    [10, false, 3, null]
  );
  let bad = [];
  try {
    v.parseStation({ ...base, failover_delay_secs: 0, silence_detection: 'yes', ident_file_id: 'x' });
  } catch (err) {
    bad = err.details.map((d) => d.field);
  }
  assert.deepStrictEqual(bad, ['failover_delay_secs', 'silence_detection', 'ident_file_id']);
});

test('settings and storage quotas are validated', () => {
  assert.deepStrictEqual(v.parseSettings({ ident_max_seconds: 8, default_storage_quota_mb: 2048 }), { ident_max_seconds: 8, default_storage_quota_mb: 2048 });
  assert.throws(() => v.parseSettings({ ident_max_seconds: 31 }));
  assert.throws(() => v.parseSettings({ dropbox_app_key: 'has spaces' }));
  assert.deepStrictEqual(v.parseUser({ storage_quota_mb: null }, { partial: true }), { storage_quota_mb: null });
  assert.throws(() => v.parseUser({ storage_quota_mb: -1 }, { partial: true }));
});

test('a stream is described with the features its type allows', () => {
  const types = require('../src/streamtypes');
  assert.strictEqual(types.describe({}), null);
  const mp3 = types.describe({ framed: '1', codec: 'mp3', profile: 'mp3', sample_rate: '44100', channels: '2', bitrate: '96', content_type: 'audio/mpeg' });
  assert.strictEqual(mp3.summary, 'MP3, 96 kbps, 44.1 kHz, stereo');
  assert.deepStrictEqual(mp3.features, { silence_detection: true, fades: true, idents: true, fallback_audio: true });

  const vbr = types.describe({ codec: 'mp3', sample_rate: '44100', channels: '1', bitrate: '0', vbr: '1' });
  assert.strictEqual(vbr.bitrate_kbps, null);
  assert.strictEqual(vbr.summary, 'MP3, variable bitrate, 44.1 kHz, mono');

  // Recorded before profiles existed: a low-rate AAC stream is taken to be AAC+.
  const plus = types.describe({ codec: 'aac', sample_rate: '22050', channels: '2', bitrate: '48' });
  assert.strictEqual(plus.type, 'he-aac');
  assert.strictEqual(plus.features.silence_detection, false);
  assert.strictEqual(plus.features.fallback_audio, true);
  assert.strictEqual(types.describe({ codec: 'aac', sample_rate: '44100', channels: '2', bitrate: '96' }).features.fades, false);

  const other = types.describe({ framed: '0', content_type: 'application/ogg' });
  assert.strictEqual(other.type, 'other');
  assert.strictEqual(other.codec, null);
  assert.ok(Object.values(other.features).every((on) => on === false));
});
