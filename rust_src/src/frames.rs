//! Audio frame boundaries for MP3 and AAC (ADTS), without decoding.
//!
//! The engine never decodes or re-encodes audio. To switch cleanly between a
//! live stream, an ident and a fallback file it only has to cut between whole
//! frames, and to notice dead air it only has to read each frame's header:
//! an encoder given silence marks the frame as carrying no audio data.
//!
//! Streams in other formats (Ogg and the like) cannot be cut this way; they
//! are relayed as raw bytes and get neither idents nor fallback files.

use bytes::{Buf, Bytes, BytesMut};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    Mp3,
    Aac,
}

impl Codec {
    pub fn as_str(self) -> &'static str {
        match self {
            Codec::Mp3 => "mp3",
            Codec::Aac => "aac",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Codec::Mp3 => "audio/mpeg",
            Codec::Aac => "audio/aac",
        }
    }
}

/// What must be the same on both sides of a cut for players not to notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    pub codec: Codec,
    pub sample_rate: u32,
    pub channels: u8,
}

impl std::fmt::Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let channels = if self.channels == 1 { "mono" } else { "stereo" };
        write!(f, "{} {} Hz {channels}", self.codec.as_str().to_uppercase(), self.sample_rate)
    }
}

#[derive(Clone, Debug)]
pub struct Frame {
    pub data: Bytes,
    pub format: Format,
    /// Playing time of this frame, in microseconds.
    pub duration_us: u64,
    /// Bitrate from the header (MP3 only; 0 for AAC, where it is not stated).
    pub bitrate_kbps: u32,
    /// The encoder marked this frame as carrying no audio: digital silence.
    pub silent: bool,
}

struct Header {
    format: Format,
    frame_len: usize,
    samples: u32,
    bitrate_kbps: u32,
}

const MP3_BITRATES_V1: [u32; 16] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2: [u32; 16] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const AAC_RATES: [u32; 13] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/// MPEG-1/2/2.5 Layer III frame header.
fn parse_mp3(b: &[u8]) -> Option<Header> {
    if b.len() < 4 || b[0] != 0xFF || b[1] & 0xE0 != 0xE0 {
        return None;
    }
    let version = (b[1] >> 3) & 0x03; // 0 = 2.5, 2 = 2, 3 = 1
    let layer = (b[1] >> 1) & 0x03; // 1 = Layer III
    if version == 1 || layer != 1 {
        return None;
    }
    let bitrate_index = (b[2] >> 4) as usize;
    let rate_index = ((b[2] >> 2) & 0x03) as usize;
    if bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
        return None;
    }
    let padding = ((b[2] >> 1) & 0x01) as usize;
    let mpeg1 = version == 3;
    let bitrate_kbps = if mpeg1 { MP3_BITRATES_V1[bitrate_index] } else { MP3_BITRATES_V2[bitrate_index] };
    let sample_rate = match version {
        3 => [44100, 48000, 32000][rate_index],
        2 => [22050, 24000, 16000][rate_index],
        _ => [11025, 12000, 8000][rate_index],
    };
    let (coefficient, samples) = if mpeg1 { (144, 1152) } else { (72, 576) };
    let frame_len = (coefficient * bitrate_kbps * 1000 / sample_rate) as usize + padding;
    let channels = if (b[3] >> 6) == 3 { 1 } else { 2 };
    Some(Header { format: Format { codec: Codec::Mp3, sample_rate, channels }, frame_len, samples, bitrate_kbps })
}

/// AAC in an ADTS container, as Icecast and SHOUTcast carry it.
fn parse_adts(b: &[u8]) -> Option<Header> {
    if b.len() < 7 || b[0] != 0xFF || b[1] & 0xF6 != 0xF0 {
        return None; // syncword, and layer bits that must be 00
    }
    let rate_index = ((b[2] >> 2) & 0x0F) as usize;
    let sample_rate = *AAC_RATES.get(rate_index)?;
    let channel_config = ((b[2] & 0x01) << 2) | (b[3] >> 6);
    let frame_len = (((b[3] & 0x03) as usize) << 11) | ((b[4] as usize) << 3) | ((b[5] >> 5) as usize);
    let blocks = (b[6] & 0x03) as u32 + 1;
    if frame_len < 7 || channel_config == 0 {
        return None;
    }
    let channels = if channel_config == 1 { 1 } else { 2 };
    Some(Header { format: Format { codec: Codec::Aac, sample_rate, channels }, frame_len, samples: 1024 * blocks, bitrate_kbps: 0 })
}

fn parse_header(b: &[u8]) -> Option<Header> {
    parse_mp3(b).or_else(|| parse_adts(b))
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Bits<'_> {
    fn read(&mut self, count: usize) -> Option<u32> {
        let mut value = 0u32;
        for _ in 0..count {
            let byte = *self.data.get(self.pos / 8)?;
            value = (value << 1) | ((byte >> (7 - self.pos % 8)) & 1) as u32;
            self.pos += 1;
        }
        Some(value)
    }
}

/// Makes the first frames after a cut safe to decode.
///
/// An MP3 frame may keep the start of its audio data in space left over in the
/// frames before it. Joined in mid-stream, a player would look for that data in
/// whatever it was playing before the cut and decode a burst of noise. `Entry`
/// replaces such frames, for the few it takes (normally one or two, about 26 ms
/// each), with frames that decode to silence while still carrying the bytes
/// later frames refer back to. From the first frame whose data is all present
/// the stream passes through untouched. Nothing is decoded; AAC needs none of this.
pub struct Entry {
    /// Bytes of audio data sent since the cut, which later frames may refer back to.
    available: usize,
    silenced: u8,
    done: bool,
}

impl Entry {
    /// More than a player's look-back (511 bytes) can ever need, even at low bitrates.
    const MAX_SILENCED: u8 = 8;

    pub fn new() -> Self {
        Self { available: 0, silenced: 0, done: false }
    }

    /// Returns what to send in place of `frame`, or `None` to send it as it is.
    pub fn admit(&mut self, frame: &Frame) -> Option<Bytes> {
        if self.done {
            return None;
        }
        let data = &frame.data;
        let Some(SideInfo { mpeg1, start, len: side, .. }) = SideInfo::of(frame) else {
            self.done = true;
            return None;
        };
        // main_data_begin: how far back, in bytes, this frame's audio data starts.
        let begin = if mpeg1 { (data[start] as usize) << 1 | (data[start + 1] >> 7) as usize } else { data[start] as usize };
        if begin <= self.available || self.silenced >= Self::MAX_SILENCED {
            self.done = true;
            return None;
        }
        // All-zero side information is a valid frame with no audio in it.
        let mut silent = data.to_vec();
        silent[start..start + side].fill(0);
        seal(&mut silent, start, side);
        self.available += data.len() - start - side;
        self.silenced += 1;
        Some(Bytes::from(silent))
    }
}

/// Where an MP3 frame's side information is: the few bytes after the header
/// that say how the audio data that follows is laid out.
struct SideInfo {
    mpeg1: bool,
    mono: bool,
    start: usize,
    len: usize,
}

impl SideInfo {
    fn of(frame: &Frame) -> Option<Self> {
        let data = &frame.data;
        if frame.format.codec != Codec::Mp3 || data.len() < 4 {
            return None;
        }
        let mpeg1 = (data[1] >> 3) & 3 == 3;
        let mono = data[3] >> 6 == 3;
        let start = if data[1] & 1 == 0 { 6 } else { 4 }; // a checksum follows the header when protected
        let len = match (mpeg1, mono) {
            (true, true) => 17,
            (true, false) => 32,
            (false, true) => 9,
            (false, false) => 17,
        };
        (data.len() >= start + len).then_some(Self { mpeg1, mono, start, len })
    }
}

/// Brings a protected frame's checksum up to date after its side information was edited.
fn seal(frame: &mut [u8], start: usize, side: usize) {
    if start == 6 {
        let crc = crc16(frame[2..4].iter().chain(&frame[6..6 + side]));
        frame[4..6].copy_from_slice(&crc.to_be_bytes());
    }
}

/// Turns an MP3 frame down without decoding it, for fades.
///
/// Each half of a frame (a granule) states its overall level in a field of its
/// side information, `global_gain`, in steps of 1.5 dB. Lowering that number is
/// an exact volume change: the audio data itself is not touched. `steps` gives
/// the reduction for the first and second granule. Returns `None` for anything
/// that is not an MP3 frame; AAC keeps its level where only decoding can reach.
pub fn attenuate(frame: &Frame, steps: [u8; 2]) -> Option<Bytes> {
    let SideInfo { mpeg1, mono, start, len } = SideInfo::of(frame)?;
    let channels = if mono { 1 } else { 2 };
    // Bits before the first granule, and the size of each granule's entry per channel.
    let (lead, entry, granules) = match (mpeg1, mono) {
        (true, true) => (18, 59, 2),
        (true, false) => (20, 59, 2),
        (false, true) => (9, 63, 1),
        (false, false) => (10, 63, 1),
    };
    let mut out = frame.data.to_vec();
    for granule in 0..granules {
        for channel in 0..channels {
            // part2_3_length (12 bits) and big_values (9) come before global_gain (8).
            let bit = start * 8 + lead + (granule * channels + channel) * entry + 21;
            let (byte, shift) = (bit / 8, bit % 8);
            let gain = if shift == 0 { out[byte] } else { (out[byte] << shift) | (out[byte + 1] >> (8 - shift)) };
            let lowered = gain.saturating_sub(steps[granule]);
            if shift == 0 {
                out[byte] = lowered;
            } else {
                out[byte] = (out[byte] & (0xff << (8 - shift))) | (lowered >> shift);
                out[byte + 1] = (out[byte + 1] & (0xff >> shift)) | (lowered << (8 - shift));
            }
        }
    }
    seal(&mut out, start, len);
    Some(Bytes::from(out))
}

/// The checksum of a protected MPEG audio frame (CRC-16, polynomial 0x8005).
fn crc16<'a>(bytes: impl Iterator<Item = &'a u8>) -> u16 {
    let mut crc = 0xffffu16;
    for byte in bytes {
        crc ^= (*byte as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x8005 } else { crc << 1 };
        }
    }
    crc
}

/// True when every granule of an MP3 frame codes no spectral data at all,
/// which is how an encoder writes digital silence. Read from the side
/// information that follows the header; nothing is decoded.
fn mp3_is_silent(frame: &[u8], header: &Header) -> bool {
    let mpeg1 = header.samples == 1152;
    let crc = frame[1] & 0x01 == 0;
    let start = 4 + if crc { 2 } else { 0 };
    let mut bits = Bits { data: &frame[start.min(frame.len())..], pos: 0 };
    let channels = header.format.channels as usize;
    let read = (|| {
        // main_data_begin, private bits, and (MPEG-1 only) scale factor selection.
        if mpeg1 {
            bits.read(9)?;
            bits.read(if channels == 1 { 5 } else { 3 })?;
            bits.read(4 * channels)?;
        } else {
            bits.read(8)?;
            bits.read(if channels == 1 { 1 } else { 2 })?;
        }
        let granules = if mpeg1 { 2 } else { 1 };
        let rest = if mpeg1 { 59 - 21 } else { 63 - 21 };
        let mut coded = 0u32;
        for _ in 0..granules * channels {
            let _part2_3_length = bits.read(12)?;
            coded += bits.read(9)?; // big_values: how many spectral values are coded
            let mut left = rest;
            while left > 0 {
                let step = left.min(24);
                bits.read(step)?;
                left -= step;
            }
        }
        Some(coded == 0)
    })();
    read.unwrap_or(false)
}

/// An AAC frame with nothing in it is only a few bytes long: the header and
/// an (almost) empty channel element per channel.
fn aac_is_silent(frame: &[u8], header: &Header) -> bool {
    let header_len = if frame[1] & 0x01 == 0 { 9 } else { 7 };
    frame.len() <= header_len + 6 * header.format.channels as usize
}

/// Cuts a byte stream into whole frames. Bytes that are not part of a frame
/// (tags, a partial frame at the start) are skipped.
pub struct Framer {
    buf: BytesMut,
    /// The format the stream settled on; a stray header of another format
    /// inside the data is then not mistaken for a frame.
    locked: Option<Format>,
}

impl Framer {
    pub fn new() -> Self {
        Self { buf: BytesMut::new(), locked: None }
    }

    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<Frame>) {
        self.buf.extend_from_slice(chunk);
        loop {
            // Look for a header...
            let Some(start) = self.buf.windows(2).position(|w| w[0] == 0xFF && w[1] & 0xE0 == 0xE0) else {
                let keep = self.buf.len().min(1);
                self.buf.advance(self.buf.len() - keep);
                return;
            };
            self.buf.advance(start);
            if self.buf.len() < 7 {
                return;
            }
            let Some(header) = parse_header(&self.buf).filter(|h| self.locked.is_none_or(|f| f == h.format)) else {
                self.buf.advance(1);
                continue;
            };
            // ...and accept it only if another header follows where this
            // frame says it ends. That rules out look-alike bytes in the data.
            if self.buf.len() < header.frame_len + 7 {
                return;
            }
            let next_ok = parse_header(&self.buf[header.frame_len..]).is_some_and(|next| next.format == header.format);
            if !next_ok {
                self.buf.advance(1);
                continue;
            }
            let data = self.buf.split_to(header.frame_len).freeze();
            let silent = match header.format.codec {
                Codec::Mp3 => mp3_is_silent(&data, &header),
                Codec::Aac => aac_is_silent(&data, &header),
            };
            self.locked = Some(header.format);
            out.push(Frame {
                data,
                format: header.format,
                duration_us: header.samples as u64 * 1_000_000 / header.format.sample_rate as u64,
                bitrate_kbps: header.bitrate_kbps,
                silent,
            });
        }
    }
}

/// Whether a stream with this Content-Type can be cut into frames here.
pub fn supported(content_type: &str) -> bool {
    let kind = content_type.to_ascii_lowercase();
    kind.contains("mpeg") || kind.contains("mp3") || kind.contains("aac")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 96 kbps, 44.1 kHz stereo MPEG-1 Layer III frame: 313 bytes unpadded.
    fn mp3_frame(silent: bool) -> Vec<u8> {
        let mut frame = vec![0u8; 313];
        frame[..4].copy_from_slice(&[0xFF, 0xFB, 0x70, 0x00]);
        if !silent {
            // big_values of the first granule: bits 32..41 after the 20 bits
            // of main_data_begin, private bits and scfsi, then part2_3_length.
            frame[4 + 4] = 0x0F;
        }
        frame
    }

    fn adts_frame(len: usize) -> Vec<u8> {
        // AAC LC, 44.1 kHz (index 4), stereo, no CRC.
        let mut frame = vec![0u8; len];
        frame[0] = 0xFF;
        frame[1] = 0xF1;
        frame[2] = (1 << 6) | (4 << 2);
        frame[3] = (2 << 6) | ((len >> 11) as u8 & 0x03);
        frame[4] = (len >> 3) as u8;
        frame[5] = ((len & 0x07) as u8) << 5 | 0x1F;
        frame[6] = 0xFC;
        frame
    }

    fn frames_of(stream: &[u8], step: usize) -> Vec<Frame> {
        let mut framer = Framer::new();
        let mut out = Vec::new();
        for piece in stream.chunks(step) {
            framer.push(piece, &mut out);
        }
        out
    }

    #[test]
    fn mp3_header_fields() {
        let header = parse_mp3(&mp3_frame(false)).unwrap();
        assert_eq!(header.format, Format { codec: Codec::Mp3, sample_rate: 44100, channels: 2 });
        assert_eq!((header.frame_len, header.samples, header.bitrate_kbps), (313, 1152, 96));
        assert!(parse_mp3(&[0xFF, 0xFB, 0x00, 0x00]).is_none(), "free-format bitrate is not accepted");
        assert!(parse_mp3(&[0xFF, 0xF1, 0x50, 0x80]).is_none(), "an ADTS header is not an MP3 header");
    }

    #[test]
    fn frames_survive_any_chunking_and_leading_junk() {
        let mut stream = b"ID3 some tag bytes \xFF\x00 not a frame".to_vec();
        for _ in 0..6 {
            stream.extend(mp3_frame(false));
        }
        for step in [1, 7, 100, 313, 5000] {
            let frames = frames_of(&stream, step);
            // The last frame is held back until the next header confirms it.
            assert_eq!(frames.len(), 5, "chunk size {step}");
            assert!(frames.iter().all(|f| f.data.len() == 313 && f.data[0] == 0xFF));
            assert_eq!(frames[0].duration_us, 26122);
        }
    }

    #[test]
    fn digital_silence_is_read_from_the_frame_header() {
        let mut stream = Vec::new();
        for silent in [false, true, true, false, false] {
            stream.extend(mp3_frame(silent));
        }
        let flags: Vec<bool> = frames_of(&stream, 64).iter().map(|f| f.silent).collect();
        assert_eq!(flags, vec![false, true, true, false]);
    }

    #[test]
    fn adts_frames_and_their_silence() {
        let mut stream = Vec::new();
        for len in [200, 13, 180, 150] {
            stream.extend(adts_frame(len));
        }
        let frames = frames_of(&stream, 50);
        assert_eq!(frames.iter().map(|f| f.data.len()).collect::<Vec<_>>(), vec![200, 13, 180]);
        assert_eq!(frames[0].format, Format { codec: Codec::Aac, sample_rate: 44100, channels: 2 });
        assert_eq!(frames.iter().map(|f| f.silent).collect::<Vec<_>>(), vec![false, true, false]);
        assert_eq!(frames[0].duration_us, 23219);
    }

    #[test]
    fn a_stream_does_not_change_format_midway() {
        let mut stream = Vec::new();
        for _ in 0..3 {
            stream.extend(mp3_frame(false));
        }
        stream.extend(adts_frame(100));
        stream.extend(adts_frame(100));
        let frames = frames_of(&stream, 4096);
        assert!(frames.iter().all(|f| f.format.codec == Codec::Mp3));
    }
}

#[cfg(test)]
mod entry_tests {
    use super::*;

    // An MPEG-1 Layer III stereo frame at 96 kbps (313 bytes) whose data starts `begin` bytes back.
    fn frame(begin: u16, protected: bool) -> Frame {
        let mut data = vec![0xaau8; 313];
        data[..4].copy_from_slice(&[0xff, if protected { 0xfa } else { 0xfb }, 0x70, 0x00]);
        let start = if protected { 6 } else { 4 };
        data[start] = (begin >> 1) as u8;
        data[start + 1] = ((begin & 1) as u8) << 7 | 0x2a;
        let format = Format { codec: Codec::Mp3, sample_rate: 44100, channels: 2 };
        Frame { data: Bytes::from(data), format, duration_us: 26122, bitrate_kbps: 96, silent: false }
    }

    #[test]
    fn frames_that_reach_back_past_the_cut_are_silenced() {
        let mut entry = Entry::new();
        let first = frame(400, false);
        let sent = entry.admit(&first).expect("its data starts before the cut");
        assert_eq!(sent.len(), first.data.len());
        assert_eq!(&sent[..4], &first.data[..4]);
        assert!(sent[4..36].iter().all(|b| *b == 0), "side information is cleared");
        assert_eq!(&sent[36..], &first.data[36..], "the data later frames refer back to is kept");
        // 277 bytes are now behind us: 400 still reaches too far, 277 does not.
        assert!(entry.admit(&frame(400, false)).is_some());
        assert!(entry.admit(&frame(500, false)).is_none());
        // Once the stream is whole it is never touched again.
        assert!(entry.admit(&frame(511, false)).is_none());
    }

    #[test]
    fn a_frame_that_stands_alone_passes_untouched() {
        let mut entry = Entry::new();
        assert!(entry.admit(&frame(0, false)).is_none());
        assert!(entry.admit(&frame(300, false)).is_none());
    }

    #[test]
    fn protected_frames_get_a_matching_checksum() {
        let sent = Entry::new().admit(&frame(100, true)).unwrap();
        let expected = crc16(sent[2..4].iter().chain(&sent[6..38]));
        assert_eq!(u16::from_be_bytes([sent[4], sent[5]]), expected);
        assert_eq!(crc16(b"123456789".iter()), 0xaee7, "CRC-16 with polynomial 0x8005, start 0xffff, no reflection");
    }

    #[test]
    fn attenuation_lowers_only_the_gain_fields() {
        // Stereo MPEG-1: gains sit 21 bits into each 59-bit entry, after 20 leading bits.
        let original = frame(0, false);
        let quieter = attenuate(&original, [10, 20]).unwrap();
        let gain = |data: &[u8], index: usize| {
            let bit = 4 * 8 + 20 + index * 59 + 21;
            ((data[bit / 8] as u16) << 8 | data[bit / 8 + 1] as u16) << (bit % 8) >> 8 & 0xff
        };
        for index in 0..4 {
            let step = if index < 2 { 10 } else { 20 };
            assert_eq!(gain(&quieter, index), gain(&original.data, index) - step, "granule/channel {index}");
        }
        // Putting the gains back gives the original frame: nothing else was touched.
        let differing = quieter.iter().zip(original.data.iter()).filter(|(a, b)| a != b).count();
        assert!(differing <= 8, "{differing} bytes differ");
        assert_eq!(quieter[36..], original.data[36..], "audio data is untouched");
        assert_eq!(attenuate(&original, [0, 0]).unwrap(), original.data);
        // Never below zero.
        let floor = attenuate(&original, [255, 255]).unwrap();
        assert!((0..4).all(|index| gain(&floor, index) == 0));
    }

    #[test]
    fn aac_is_left_alone() {
        let format = Format { codec: Codec::Aac, sample_rate: 44100, channels: 2 };
        let aac = Frame { data: Bytes::from(vec![0xffu8; 200]), format, duration_us: 23219, bitrate_kbps: 0, silent: false };
        assert!(Entry::new().admit(&aac).is_none());
        assert!(attenuate(&aac, [10, 10]).is_none());
    }
}

/// Checks against real encoder output. Generate the files with ffmpeg and
/// point TEST_AUDIO_DIR at them (see the test for the names); skipped otherwise.
#[cfg(test)]
mod real_audio {
    use super::*;

    fn frames(name: &str) -> Option<Vec<Frame>> {
        let dir = std::env::var("TEST_AUDIO_DIR").ok()?;
        let data = std::fs::read(format!("{dir}/{name}")).ok()?;
        let mut framer = Framer::new();
        let mut out = Vec::new();
        for piece in data.chunks(1500) {
            framer.push(piece, &mut out);
        }
        Some(out)
    }

    fn report(name: &str) -> Option<(usize, usize, Format, f64)> {
        let frames = frames(name)?;
        let silent = frames.iter().filter(|f| f.silent).count();
        let seconds = frames.iter().map(|f| f.duration_us).sum::<u64>() as f64 / 1e6;
        println!("{name}: {} frames, {silent} silent, {} , {seconds:.2}s", frames.len(), frames[0].format);
        Some((frames.len(), silent, frames[0].format, seconds))
    }

    #[test]
    fn encoder_output() {
        let Some((count, silent, format, seconds)) = report("tone.mp3") else { return };
        assert_eq!(format, Format { codec: Codec::Mp3, sample_rate: 44100, channels: 2 });
        assert!(count > 300 && (9.5..10.5).contains(&seconds), "a 10 s file should give about 383 frames");
        assert_eq!(silent, 0, "a tone is never silent");

        let (count, silent, _, _) = report("silence.mp3").unwrap();
        assert!(silent as f64 > count as f64 * 0.95, "digital silence must be recognised in MP3");

        let (count, silent, format, seconds) = report("tone.aac").unwrap();
        assert_eq!(format, Format { codec: Codec::Aac, sample_rate: 44100, channels: 2 });
        assert!(count > 400 && (9.5..10.5).contains(&seconds));
        assert_eq!(silent, 0);

        let (count, silent, _, _) = report("silence.aac").unwrap();
        assert!(silent as f64 > count as f64 * 0.95, "digital silence must be recognised in AAC");

        // Quiet but not silent: hiss at -60 dB. Not detected without decoding, by design.
        report("hiss.mp3");
        report("hiss.aac");
        report("tone-mono-22k.mp3");
        report("tagged.mp3");
    }
}
