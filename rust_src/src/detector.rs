//! Listens to a stream just enough to tell whether there is anything to hear.
//!
//! Frame headers show digital silence, but not a stream that carries only
//! hiss from an open input, and not silence in formats whose silent frames
//! look like any other (HE-AAC). The only way to know is to decode, so this
//! does, sparingly: a few times a second it decodes a short run of consecutive
//! frames and looks at how loud the last of them are. The rest of the stream is
//! never decoded, which keeps the cost to a small fraction of playing it.
//! What is decoded is measured and thrown away; listeners always receive the
//! stream's own bytes.

use std::time::Duration;

use ffmpeg_next as ffmpeg;
use ffmpeg::format::sample::{Sample, Type};
use tokio::time::Instant;

use crate::frames::{Codec, Frame};

/// How often a measurement is taken.
const INTERVAL: Duration = Duration::from_millis(500);
/// Frames decoded before the ones that are measured. An MP3 frame can keep
/// part of its audio in up to 511 bytes of the frames before it, and both
/// codecs overlap each frame with the one before, so the first frames after a
/// gap do not decode to what was broadcast. With less lead-in than this the
/// level of an MP3 stream reads about a decibel low.
const LEAD_BYTES: usize = 1100;
const LEAD_FRAMES: usize = 3;
/// Frames measured each time: about 50 ms of audio.
const MEASURED_FRAMES: usize = 2;
/// Consecutive measurements that could not be made before decoding is given up
/// on for this stream and frame headers are relied on instead.
const MAX_FAILURES: u32 = 20;
/// Measurements with sound before the stream's level is stated (20 seconds'
/// worth), and how many the running average remembers (ten minutes' worth).
const LEVEL_AFTER: u32 = 40;
const LEVEL_MEMORY: u32 = 1200;

/// What decoding revealed about the stream itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decoded {
    /// The rate the audio plays at. Twice what the frame headers state for HE-AAC.
    pub sample_rate: u32,
    pub channels: u8,
    /// HE-AAC (spectral band replication), found in the stream rather than guessed.
    pub he_aac: bool,
}

pub enum Verdict {
    /// Nothing was measured in these frames; the last verdict stands.
    Pending,
    Loud,
    Quiet,
    /// Decoding is not possible for this stream.
    Unavailable,
}

enum State {
    Waiting,
    /// Decoding a run of frames: bytes and frames fed so far, how many have been measured, and the loudest sample among those.
    Running { bytes: usize, frames: usize, measured: usize, peak: f32, power: f64 },
}

pub struct Detector {
    decoder: Option<ffmpeg::decoder::Audio>,
    output: ffmpeg::frame::Audio,
    /// Linear amplitude (1.0 is full scale) below which audio counts as silence.
    threshold: f32,
    next: Instant,
    interval: Duration,
    state: State,
    failures: u32,
    header_rate: u32,
    decoded: Option<Decoded>,
    reported: bool,
    /// The stream's average power while it has sound, and how many measurements went into it.
    power: f64,
    heard: u32,
}

// The decoder is only ever used by the one task that owns it.
unsafe impl Send for Detector {}

impl Detector {
    /// `threshold_db` is relative to full scale, e.g. -55.
    pub fn new(codec: Codec, header_rate: u32, threshold_db: f32) -> Self {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            let _ = ffmpeg::init();
            // A damaged frame is an everyday event on a live stream, not something to print.
            ffmpeg::util::log::set_level(ffmpeg::util::log::Level::Quiet);
        });
        let id = match codec {
            Codec::Mp3 => ffmpeg::codec::Id::MP3,
            Codec::Aac => ffmpeg::codec::Id::AAC,
        };
        let decoder = ffmpeg::decoder::find(id)
            .and_then(|codec| ffmpeg::codec::Context::new_with_codec(codec).decoder().audio().ok());
        Self {
            decoder,
            output: ffmpeg::frame::Audio::empty(),
            threshold: 10f32.powf(threshold_db / 20.0),
            next: Instant::now(),
            interval: INTERVAL,
            state: State::Waiting,
            failures: 0,
            header_rate,
            decoded: None,
            reported: false,
            power: 0.0,
            heard: 0,
        }
    }

    /// What decoding showed the stream to be, the first time it is known.
    pub fn newly_decoded(&mut self) -> Option<Decoded> {
        if self.reported {
            return None;
        }
        self.reported = self.decoded.is_some();
        self.decoded
    }

    /// How loud the stream is on average, in dB relative to full scale (the
    /// mean level, as `ffmpeg -af volumedetect` reports it), once enough of it
    /// has been heard to say. Silent stretches are left out. Uploaded files
    /// are brought to this level when they are converted for the station.
    pub fn level_db(&self) -> Option<f32> {
        (self.heard >= LEVEL_AFTER && self.power > 0.0).then(|| (10.0 * self.power.log10()) as f32)
    }

    /// Takes the stream's frames in order and says what, if anything, was heard.
    pub fn feed(&mut self, frames: &[Frame]) -> Verdict {
        let Some(decoder) = self.decoder.as_mut() else { return Verdict::Unavailable };
        let mut verdict = Verdict::Pending;
        for frame in frames {
            if matches!(self.state, State::Waiting) {
                if Instant::now() < self.next {
                    // Nothing due: the rest of this batch is skipped too.
                    break;
                }
                decoder.flush();
                self.state = State::Running { bytes: 0, frames: 0, measured: 0, peak: 0.0, power: 0.0 };
            }
            let State::Running { bytes, frames: fed, measured, peak, power } = &mut self.state else { unreachable!() };
            // Only MP3 keeps audio in earlier frames; AAC needs just the overlap.
            let lead_in = *fed < LEAD_FRAMES || (frame.format.codec == Codec::Mp3 && *bytes < LEAD_BYTES);
            *bytes += frame.data.len();
            *fed += 1;

            let mut heard = None;
            if decoder.send_packet(&ffmpeg::Packet::copy(&frame.data)).is_ok() {
                while decoder.receive_frame(&mut self.output).is_ok() {
                    let (loudest, mean_square) = measure(&self.output).unwrap_or((0.0, 0.0));
                    let (so_far, power_so_far) = heard.unwrap_or((0f32, 0f64));
                    heard = Some((so_far.max(loudest), power_so_far.max(mean_square)));
                    if self.decoded.is_none() {
                        let rate = self.output.rate();
                        self.decoded = Some(Decoded {
                            sample_rate: rate,
                            channels: self.output.channels() as u8,
                            he_aac: frame.format.codec == Codec::Aac && rate >= self.header_rate * 2,
                        });
                    }
                }
            }
            if lead_in {
                continue;
            }
            match heard {
                Some((level, mean_square)) => {
                    *peak = peak.max(level);
                    *power += mean_square;
                    *measured += 1;
                }
                // The frame did not decode. Give the run a few more frames, then abandon it.
                None if *fed > 40 => {
                    self.state = State::Waiting;
                    self.next = Instant::now() + self.interval;
                    self.failures += 1;
                    if self.failures >= MAX_FAILURES {
                        self.decoder = None;
                        return Verdict::Unavailable;
                    }
                    break;
                }
                None => continue,
            }
            if *measured >= MEASURED_FRAMES {
                verdict = if *peak >= self.threshold { Verdict::Loud } else { Verdict::Quiet };
                if matches!(verdict, Verdict::Loud) {
                    // A plain average at first, then one that follows the stream slowly (over about ten minutes).
                    self.heard = (self.heard + 1).min(LEVEL_MEMORY);
                    self.power += (*power / *measured as f64 - self.power) / self.heard as f64;
                }
                self.state = State::Waiting;
                self.next = Instant::now() + self.interval;
                self.failures = 0;
            }
        }
        verdict
    }
}

/// The largest sample in a decoded frame, as a fraction of full scale, and the
/// mean of its squared samples (its power).
fn measure(frame: &ffmpeg::frame::Audio) -> Option<(f32, f64)> {
    let samples = frame.samples();
    let channels = (frame.channels() as usize).max(1);
    let (planes, per_plane) = match frame.format() {
        Sample::U8(kind) | Sample::I16(kind) | Sample::I32(kind) | Sample::I64(kind) | Sample::F32(kind) | Sample::F64(kind) => match kind {
            Type::Planar => (frame.planes(), samples),
            Type::Packed => (1, samples * channels),
        },
        Sample::None => return None,
    };
    let mut peak = 0f32;
    let mut squares = 0f64;
    let mut count = 0usize;
    let mut note = |value: f32| {
        peak = peak.max(value.abs());
        squares += (value as f64) * (value as f64);
        count += 1;
    };
    for plane in 0..planes {
        let data = frame.data(plane);
        match frame.format() {
            Sample::F32(_) => {
                for value in data.chunks_exact(4).take(per_plane) {
                    note(f32::from_ne_bytes([value[0], value[1], value[2], value[3]]));
                }
            }
            Sample::I16(_) => {
                for value in data.chunks_exact(2).take(per_plane) {
                    note(i16::from_ne_bytes([value[0], value[1]]) as f32 / 32768.0);
                }
            }
            Sample::I32(_) => {
                for value in data.chunks_exact(4).take(per_plane) {
                    note(i32::from_ne_bytes([value[0], value[1], value[2], value[3]]) as f32 / 2_147_483_648.0);
                }
            }
            _ => return None,
        }
    }
    // A decoder that fails inside a frame can leave NaN behind.
    if !peak.is_finite() || !squares.is_finite() || count == 0 {
        return Some((0.0, 0.0));
    }
    Some((peak, squares / count as f64))
}

/// Checks against real encoder output: point TEST_AUDIO_DIR at files made with
/// ffmpeg (see the names below); skipped otherwise.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::Framer;

    /// Runs a whole file through the detector with no pause between measurements.
    fn listen(name: &str, threshold_db: f32) -> Option<(u32, u32, Option<Decoded>, f64)> {
        let dir = std::env::var("TEST_AUDIO_DIR").ok()?;
        let data = std::fs::read(format!("{dir}/{name}")).ok()?;
        let mut frames = Vec::new();
        let mut framer = Framer::new();
        for piece in data.chunks(1500) {
            framer.push(piece, &mut frames);
        }
        let mut detector = Detector::new(frames[0].format.codec, frames[0].format.sample_rate, threshold_db);
        detector.interval = Duration::ZERO;
        let (mut loud, mut quiet) = (0, 0);
        let started = std::time::Instant::now();
        for batch in frames.chunks(4) {
            match detector.feed(batch) {
                Verdict::Loud => loud += 1,
                Verdict::Quiet => quiet += 1,
                Verdict::Pending => {}
                Verdict::Unavailable => panic!("{name}: no decoder"),
            }
        }
        let per_measurement = started.elapsed().as_secs_f64() * 1e6 / (loud + quiet).max(1) as f64;
        println!("{name}: {loud} loud, {quiet} quiet, {:?}, level {:?} dB, {per_measurement:.0} us per measurement", detector.decoded, detector.level_db());
        Some((loud, quiet, detector.decoded, per_measurement))
    }

    #[test]
    fn hears_the_difference() {
        let Some((loud, quiet, decoded, _)) = listen("tone.mp3", -55.0) else { return };
        assert!(loud > 20 && quiet == 0, "a tone is audio");
        assert_eq!(decoded, Some(Decoded { sample_rate: 44100, channels: 2, he_aac: false }));

        for name in ["silence.mp3", "silence.aac"] {
            let (loud, quiet, _, _) = listen(name, -55.0).unwrap();
            assert!(quiet > 20 && loud == 0, "{name}: digital silence");
        }
        let (loud, quiet, _, _) = listen("tone.aac", -55.0).unwrap();
        assert!(loud > 20 && quiet == 0);

        // Hiss at about -60 dB: an open input with nothing plugged in. Silence
        // at the usual threshold, audio to someone who sets the threshold below it.
        for name in ["hiss.mp3", "hiss.aac"] {
            let (loud, quiet, _, _) = listen(name, -55.0).unwrap();
            assert!(quiet > 20 && loud == 0, "{name}: hiss is silence at -55 dB ({loud} loud, {quiet} quiet)");
            let (loud, _, _, _) = listen(name, -80.0).unwrap();
            assert!(loud > 20, "{name}: hiss is heard at -80 dB");
        }
        // Low-bitrate MP3 keeps more of each frame in the frames before it.
        if let Some((loud, quiet, _, _)) = listen("tone-32k.mp3", -55.0) {
            assert!(loud > 20 && quiet == 0, "low bitrate tone: {loud} loud, {quiet} quiet");
        }
    }
}
