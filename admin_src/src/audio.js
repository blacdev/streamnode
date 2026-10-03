// Reads what an uploaded audio file is, without decoding it, and says in
// plain words why a file cannot be used and what to do about it.
//
// The gateway never converts audio. An ident or fallback file is cut into a
// live stream between whole frames, so it has to be in the same format as
// that stream; the checks here are what stands between a wrong file and
// listeners' players stuttering or stopping.
//
// The frame parsing mirrors rust_src/src/frames.rs.

const fs = require('fs');

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

class AudioError extends Error {}

function parseMp3(b, at) {
  if (b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3; // 0 = 2.5, 2 = 2, 3 = 1
  const layer = (b[at + 1] >> 1) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = b[at + 2] >> 4;
  const rateIndex = (b[at + 2] >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex];
  const sampleRate = (version === 3 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000])[rateIndex];
  const padding = (b[at + 2] >> 1) & 1;
  return {
    codec: 'mp3',
    sampleRate,
    channels: b[at + 3] >> 6 === 3 ? 1 : 2,
    bitrate,
    samples: mpeg1 ? 1152 : 576,
    length: Math.floor(((mpeg1 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding,
  };
}

function parseAdts(b, at) {
  if (b[at] !== 0xff || (b[at + 1] & 0xf6) !== 0xf0) return null;
  const sampleRate = AAC_RATES[(b[at + 2] >> 2) & 15];
  const channelConfig = ((b[at + 2] & 1) << 2) | (b[at + 3] >> 6);
  const length = ((b[at + 3] & 3) << 11) | (b[at + 4] << 3) | (b[at + 5] >> 5);
  if (!sampleRate || channelConfig === 0 || length < 7) return null;
  return { codec: 'aac', sampleRate, channels: channelConfig === 1 ? 1 : 2, bitrate: 0, samples: 1024 * ((b[at + 6] & 3) + 1), length };
}

const parseHeader = (b, at) => (at + 7 <= b.length ? parseMp3(b, at) || parseAdts(b, at) : null);
const sameFormat = (a, b) => a.codec === b.codec && a.sampleRate === b.sampleRate && a.channels === b.channels;

// Common containers that hold audio the gateway cannot cut into a stream.
function unsupportedKind(head) {
  const text = head.toString('latin1', 0, 12);
  if (text.slice(4, 8) === 'ftyp') return 'an MP4/M4A file. Export it as MP3, or as AAC in an .aac (ADTS) file';
  if (text.startsWith('RIFF')) return 'a WAV file, which is uncompressed. Export it as MP3 or AAC (.aac)';
  if (text.startsWith('OggS')) return 'an Ogg file (Vorbis or Opus). Export it as MP3 or AAC (.aac)';
  if (text.startsWith('fLaC')) return 'a FLAC file. Export it as MP3 or AAC (.aac)';
  return null;
}

/**
 * Scans a file frame by frame and returns its format, length and where the
 * audio starts and ends (tags excluded). Throws AudioError with advice if it
 * is not usable.
 */
async function analyse(path) {
  const handle = await fs.promises.open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 64) throw new AudioError('The file is empty or too small to be audio.');
    const head = Buffer.alloc(Math.min(size, 16));
    await handle.read(head, 0, head.length, 0);
    const kind = unsupportedKind(head);
    if (kind) throw new AudioError(`This is ${kind}.`);

    // A tag at the start may hold artwork whose bytes look like audio: skip it by its stated size.
    let start = 0;
    if (head.toString('latin1', 0, 3) === 'ID3') {
      start = 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f));
    }
    // And a 128-byte tag at the end is not audio either.
    let end = size;
    if (size > 128) {
      const tail = Buffer.alloc(3);
      await handle.read(tail, 0, 3, size - 128);
      if (tail.toString('latin1') === 'TAG') end = size - 128;
    }

    const chunk = Buffer.alloc(1 << 20);
    let format = null;
    let audioOffset = null;
    let audioEnd = start;
    let frames = 0;
    let samples = 0;
    let bitrateSeen = null;
    let constant = true;
    let position = start; // file offset of the next header to read
    let skipped = 0;

    while (position + 7 <= end) {
      const want = Math.min(chunk.length, end - position);
      const { bytesRead } = await handle.read(chunk, 0, want, position);
      if (bytesRead < 7) break;
      const data = chunk.subarray(0, bytesRead);
      let at = 0;
      // Walk from frame to frame inside this block.
      while (at + 7 <= data.length) {
        const header = parseHeader(data, at);
        if (!header || (format && !sameFormat(format, header))) {
          if (format && header) {
            throw new AudioError(`The audio changes format partway through (${describe(format)} then ${describe(fromHeader(header))}). Export the file again in one format.`);
          }
          at += 1;
          skipped += 1;
          if (!format && skipped > 262144) throw new AudioError('No MP3 or AAC audio was found in this file. Export it as MP3, or as AAC in an .aac (ADTS) file.');
          continue;
        }
        // A real frame is followed by another header (or the end of the audio).
        const next = at + header.length;
        if (!format) {
          if (next + 7 > data.length) break; // need the following header from the next block
          const following = parseHeader(data, next);
          if (!following || !sameFormat(header, following)) {
            at += 1;
            skipped += 1;
            continue;
          }
          format = header;
          audioOffset = position + at;
          // An encoder's info frame holds no sound; played in a loop it would be a small gap.
          if (header.codec === 'mp3' && /Xing|Info/.test(data.toString('latin1', at + 4, Math.min(next, at + 44)))) {
            audioOffset = position + next;
            at = next;
            continue;
          }
        }
        if (position + next > end) break; // a cut-off last frame is left out
        frames += 1;
        samples += header.samples;
        if (header.codec === 'mp3') {
          if (bitrateSeen === null) bitrateSeen = header.bitrate;
          // The first frame of some encoders is a short info header at a low bitrate.
          else if (header.bitrate !== bitrateSeen && frames > 2) constant = false;
          else if (frames === 2) bitrateSeen = header.bitrate;
        }
        audioEnd = position + next;
        at = next;
      }
      if (at === 0) break; // nothing consumed: avoid looping on a truncated tail
      position += at;
    }

    if (!format || frames < 3) throw new AudioError('No MP3 or AAC audio was found in this file. Export it as MP3, or as AAC in an .aac (ADTS) file.');
    const duration = samples / format.sampleRate;
    const audioBytes = audioEnd - audioOffset;
    const average = Math.round((audioBytes * 8) / duration / 1000);
    return {
      codec: format.codec,
      sample_rate: format.sampleRate,
      channels: format.channels,
      // MP3 at a constant bitrate states it exactly; otherwise it is the average.
      bitrate_kbps: format.codec === 'mp3' && constant ? bitrateSeen : average,
      constant_bitrate: format.codec === 'mp3' ? constant : false,
      duration_seconds: Math.round(duration * 100) / 100,
      audio_offset: audioOffset,
      audio_bytes: audioBytes,
    };
  } finally {
    await handle.close();
  }
}

const fromHeader = (h) => ({ codec: h.codec, sample_rate: h.sampleRate, channels: h.channels });

function describe(f, withBitrate = true) {
  const rate = f.sample_rate || f.sampleRate;
  const parts = [f.codec.toUpperCase()];
  if (withBitrate && f.bitrate_kbps) parts.push(`${f.bitrate_kbps} kbps${f.codec === 'mp3' && f.constant_bitrate === false ? ' (variable)' : ''}`);
  parts.push(`${rate % 1000 === 0 ? rate / 1000 : (rate / 1000).toFixed(1)} kHz`, f.channels === 1 ? 'mono' : 'stereo');
  return parts.join(', ');
}

// What to export a file as so that it matches a stream.
function target(stream) {
  const bitrate = stream.bitrate_kbps ? `${stream.bitrate_kbps} kbps${stream.codec === 'mp3' ? ' constant bitrate' : ''}, ` : '';
  const container = stream.codec === 'aac' ? ' in an .aac (ADTS) file' : '';
  const rate = stream.sample_rate % 1000 === 0 ? stream.sample_rate / 1000 : (stream.sample_rate / 1000).toFixed(1);
  const name = stream.type === 'he-aac' ? 'HE-AAC (AAC+)' : stream.codec.toUpperCase();
  return `${name}${container}, ${bitrate}${rate} kHz${stream.type === 'he-aac' ? ' as the frame headers state it' : ''}, ${stream.channels === 1 ? 'mono' : 'stereo'}`;
}

/**
 * Compares a file with a station's stream. Returns the reasons it cannot be
 * used there (empty when it can), each saying what differs.
 */
function mismatches(file, stream) {
  const problems = [];
  if (file.codec !== stream.codec) problems.push(`it is ${file.codec.toUpperCase()} and the stream is ${stream.codec.toUpperCase()}`);
  if (file.sample_rate !== stream.sample_rate) problems.push(`its sample rate is ${file.sample_rate} Hz and the stream's is ${stream.sample_rate} Hz`);
  if (file.channels !== stream.channels) problems.push(`it is ${file.channels === 1 ? 'mono' : 'stereo'} and the stream is ${stream.channels === 1 ? 'mono' : 'stereo'}`);
  if (stream.bitrate_kbps) {
    if (file.codec === 'mp3' && stream.codec === 'mp3') {
      if (!file.constant_bitrate) problems.push('it uses a variable bitrate');
      else if (file.bitrate_kbps !== stream.bitrate_kbps) problems.push(`its bitrate is ${file.bitrate_kbps} kbps and the stream's is ${stream.bitrate_kbps} kbps`);
    } else if (file.codec === 'aac' && Math.abs(file.bitrate_kbps - stream.bitrate_kbps) > stream.bitrate_kbps * 0.2) {
      problems.push(`its bitrate is about ${file.bitrate_kbps} kbps and the stream's is ${stream.bitrate_kbps} kbps`);
    }
  }
  return problems;
}

module.exports = { analyse, mismatches, describe, target, AudioError };
