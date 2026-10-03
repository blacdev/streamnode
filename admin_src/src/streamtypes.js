// The kinds of stream a station can supply, and what the gateway can do with
// each. Served at /api/v1/stream-types and shown in the dashboard, so that it
// is known before a station is added; the same table decides what is reported
// for a station once its stream has been seen.

const TYPES = [
  {
    type: 'mp3',
    name: 'MP3',
    description: 'MPEG-1, 2 or 2.5 Layer III from Icecast, SHOUTcast or a hosted provider, mono or stereo, constant or variable bitrate.',
    relayed: true,
    features: { silence_detection: true, fades: true, idents: true, fallback_audio: true },
    files: 'MP3 with the same sample rate and mono or stereo as the stream; constant bitrate at the stream\'s bitrate when the stream has one.',
    notes: 'Everything is available.',
  },
  {
    type: 'aac',
    name: 'AAC',
    description: 'AAC-LC sent as ADTS frames (content type audio/aac), the usual form on Icecast and SHOUTcast.',
    relayed: true,
    features: { silence_detection: true, fades: false, idents: true, fallback_audio: true },
    files: 'AAC in an .aac (ADTS) file, not .m4a, with the stream\'s bitrate, sample rate and mono or stereo.',
    notes: 'Changes of source are direct cuts rather than fades, because the volume of AAC cannot be changed without decoding it. An ident makes the change smooth.',
  },
  {
    type: 'he-aac',
    name: 'HE-AAC (AAC+, aacPlus)',
    description: 'AAC with spectral band replication, common at 32 to 64 kbps. Recognised by the content type audio/aacp, or by frame headers that state 24 kHz or less.',
    relayed: true,
    features: { silence_detection: false, fades: false, idents: true, fallback_audio: true },
    files: 'HE-AAC in an .aac (ADTS) file made with the same encoder settings as the stream. The gateway can compare what the frame headers state, not whether the file really is HE-AAC.',
    notes: 'A stream that goes silent but stays connected is not noticed: HE-AAC frames stay full when they carry silence. A stream that stops or drops is noticed as usual.',
  },
  {
    type: 'other',
    name: 'Other audio formats',
    description: 'Ogg Vorbis, Opus, FLAC, MPEG Layer II, AAC in LATM form, or a stream whose content does not match its label.',
    relayed: true,
    features: { silence_detection: false, fades: false, idents: false, fallback_audio: false },
    files: 'None can be used.',
    notes: 'Relayed exactly as it arrives, with failover to a backup stream when it stops or drops. Nothing can be inserted into it.',
  },
  {
    type: 'unsupported',
    name: 'Not supported',
    description: 'HLS (.m3u8) and DASH, web pages that contain a player, and streams that need a username and password.',
    relayed: false,
    features: { silence_detection: false, fades: false, idents: false, fallback_audio: false },
    files: 'None.',
    notes: 'Supply the direct address of an MP3 or AAC stream instead.',
  },
];

const byType = Object.fromEntries(TYPES.map((entry) => [entry.type, entry]));

const kHz = (rate) => `${rate % 1000 === 0 ? rate / 1000 : (rate / 1000).toFixed(1)} kHz`;

/**
 * What a station's stream is and which features apply to it, from what the
 * engines last recorded (format:<slug>). null until the station has been on air.
 */
function describe(hash) {
  if (!hash || (!hash.codec && hash.framed !== '0')) return null;
  if (hash.framed === '0') {
    const other = byType.other;
    return {
      type: 'other', name: hash.content_type || other.name, summary: `${hash.content_type || 'An unrecognised format'}, relayed as it is`,
      codec: null, sample_rate: null, channels: null, bitrate_kbps: null, variable_bitrate: false,
      content_type: hash.content_type || null, features: other.features, notes: other.notes,
    };
  }
  const sampleRate = parseInt(hash.sample_rate, 10);
  // Recorded by older engines without a profile: work it out the same way.
  const type = hash.profile || (hash.codec === 'aac' && sampleRate <= 24000 ? 'he-aac' : hash.codec);
  const entry = byType[type] || byType[hash.codec];
  const channels = parseInt(hash.channels, 10);
  const bitrate = parseInt(hash.bitrate, 10) || null;
  const variable = hash.vbr === '1';
  return {
    type: entry.type,
    name: entry.name,
    summary: [entry.name, variable ? 'variable bitrate' : bitrate && `${bitrate} kbps`, kHz(sampleRate), channels === 1 ? 'mono' : 'stereo'].filter(Boolean).join(', '),
    codec: hash.codec,
    sample_rate: sampleRate,
    channels,
    bitrate_kbps: variable ? null : bitrate,
    variable_bitrate: variable,
    content_type: hash.content_type || null,
    features: entry.features,
    notes: entry.notes,
  };
}

module.exports = { TYPES, describe };
