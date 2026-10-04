// Converts an uploaded file into a station's own format, once, when its owner
// has agreed to that. Live streams are never converted; this is only for
// idents and fallback audio, so that a file need not be prepared by hand.
//
// The work is done by the ffmpeg program (in the admin image). It is given
// only local files, and only the handful of container formats listed below.

const { spawn } = require('child_process');
const os = require('os');

// What may be uploaded for conversion. Anything else is refused by ffmpeg itself.
const INPUT_FORMATS = 'mp3,aac,wav,flac,ogg,mov,matroska,aiff,w64';
// One thread throughout: a conversion takes one processor core at most.
const SAFE_INPUT = ['-nostdin', '-hide_banner', '-filter_threads', '1', '-threads', '1', '-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS];
// Loudness is matched by this much at most, either way.
const MAX_GAIN_DB = 20;

class ConvertError extends Error {}

// ffmpeg runs each stage of its work on a thread of its own, so limiting its
// codec threads does not keep it to one processor core. Where the taskset
// program exists (it does in the admin image), ffmpeg is confined to a single
// core, the last one; elsewhere it is left to its low priority.
let confine = null;
function confined(command, args) {
  if (confine === null) {
    const { spawnSync } = require('child_process');
    confine = spawnSync('taskset', ['-c', '0', 'true']).status === 0;
  }
  if (!confine || command !== 'ffmpeg') return [command, args];
  return ['taskset', ['-c', String(os.cpus().length - 1), command, ...args]];
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(...confined(command, args), { stdio: ['ignore', 'pipe', 'pipe'] });
    // Converting is never urgent: it gives way to everything else on the server.
    try {
      os.setPriority(child.pid, 19);
    } catch {
      // Not permitted here; it runs at normal priority.
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { if (out.length < 65536) out += chunk; });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-65536); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
  });
}

let present = null;
// Whether this server can convert at all (the programs are part of the admin image).
async function available() {
  if (present === null) {
    present = await Promise.all([run('ffprobe', ['-version'], 10000), run('ffmpeg', ['-version'], 10000)])
      .then((results) => results.every((r) => r.code === 0), () => false);
  }
  return present;
}

// What a file is, quickly: whether it holds audio, and for how long.
async function probe(file) {
  const result = await run('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS,
    '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', file,
  ], 60000);
  let data = null;
  try {
    data = JSON.parse(result.out);
  } catch {
    // Not something ffprobe could read.
  }
  const stream = data && data.streams && data.streams[0];
  if (result.code !== 0 || !stream) {
    throw new ConvertError('This file could not be read as audio. Upload MP3, AAC, WAV, FLAC, Ogg or M4A.');
  }
  const duration = parseFloat(data.format && data.format.duration);
  return { codec: stream.codec_name, duration_seconds: Number.isFinite(duration) ? duration : null };
}

// The shape the audio is brought to before it is measured or encoded. Mixing
// stereo down to mono changes how loud it is, so the level is always taken
// after this step, never from the file as it was uploaded.
const shape = (target) => `aformat=sample_fmts=fltp:sample_rates=${target.sample_rate}:channel_layouts=${target.channels === 1 ? 'mono' : 'stereo'}`;

// The average and peak level, in dB below full scale, that the file will have in the `target` shape.
async function level(file, target) {
  const result = await run('ffmpeg', [...SAFE_INPUT, '-nostats', '-i', file, '-map', '0:a:0', '-vn', '-af', `${shape(target)},volumedetect`, '-f', 'null', '-'], 30 * 60000);
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(result.err);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(result.err);
  if (result.code !== 0 || !mean) throw new ConvertError('The audio in this file could not be read to the end.');
  return { mean_db: parseFloat(mean[1]), max_db: max ? parseFloat(max[1]) : 0 };
}

// How much to turn a file up or down so that it sits at the stream's level.
function gainFor(fileMeanDb, streamLevelDb) {
  if (!Number.isFinite(streamLevelDb) || !Number.isFinite(fileMeanDb) || fileMeanDb < -80) return 0;
  const gain = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, streamLevelDb - fileMeanDb));
  return Math.abs(gain) < 1 ? 0 : Math.round(gain * 10) / 10;
}

/**
 * Writes `source` to `destination` in the `target` format (codec, sample_rate,
 * channels, bitrate_kbps), turned up or down by `gainDb`.
 */
async function convert(source, destination, target, gainDb) {
  const bitrate = target.bitrate_kbps || (target.codec === 'mp3' ? 128 : 96);
  // Turned up, peaks are held just under full scale rather than clipped.
  const filters = ['-af', gainDb ? `${shape(target)},volume=${gainDb}dB,alimiter=limit=0.9:level=disabled` : shape(target)];
  const encoder = target.codec === 'aac'
    ? ['-c:a', 'aac', '-b:a', `${bitrate}k`, '-f', 'adts']
    // Constant bitrate, with no tag or info frame: nothing but audio frames.
    : ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3'];
  const result = await run('ffmpeg', [
    ...SAFE_INPUT, '-v', 'error', '-y', '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
    ...filters, ...encoder, '-threads', '1', destination,
  ], 60 * 60000);
  if (result.signal) throw new ConvertError('Converting this file took too long and was stopped.');
  if (result.code !== 0) throw new ConvertError(`The file could not be converted: ${result.err.trim().split('\n').pop().slice(0, 160) || 'unknown error'}`);
}

module.exports = { available, probe, level, gainFor, convert, ConvertError };
