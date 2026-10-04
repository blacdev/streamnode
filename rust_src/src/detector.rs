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

use std::{collections::VecDeque, time::Duration};

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
/// Audio measured each time: at least two frames, and enough samples for two
/// spectra side by side (about a tenth of a second), but never more frames
/// than this.
const MEASURED_FRAMES: usize = 2;
const MAX_MEASURED_FRAMES: usize = 8;
/// Samples in one spectrum, and how many are wanted per measurement.
const SPECTRUM: usize = 2048;
const WANTED_SAMPLES: usize = 2 * SPECTRUM;

// Telling hiss from programme. Hiss, however loud, has no pitch (its energy
// is spread evenly over the spectrum) and never changes: the spectrum keeps
// the same shape from one measurement to the next. Music and speech can be
// either for a moment, but not both for seconds on end. In recordings, noise
// kept its shape within 4 dB over four seconds, and the steadiest music that
// was also pitchless moved by 11 dB.
/// How many measurements in a row must look like noise: four seconds' worth.
/// It has to be fewer than a returning stream is listened to for before the
/// station goes back to it, or hiss would be let back in before it was known.
pub const NOISE_SAMPLES: usize = 8;
/// How evenly spread the spectrum must be: 0 is a pure tone, 1 is white noise.
const NOISE_FLATNESS: f32 = 0.1;
/// How far the share of any band may move over those measurements, in dB.
const NOISE_MOVEMENT_DB: f32 = 6.0;
/// The bands whose shares make up the spectrum's shape, in Hz, and the range flatness is taken over.
const BAND_EDGES: [f32; 6] = [200.0, 800.0, 1600.0, 3200.0, 6400.0, 10000.0];
const FLATNESS_RANGE: (f32, f32) = (200.0, 8000.0);
const BANDS: usize = BAND_EDGES.len() - 1;
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
    /// Loud, but nothing but steady noise, and has been for `NOISE_SAMPLES` measurements.
    Noise,
    /// Decoding is not possible for this stream.
    Unavailable,
}

enum State {
    Waiting,
    /// Decoding a run of frames: bytes and frames fed so far, how many have been measured, and the loudest sample among those.
    Running { bytes: usize, frames: usize, measured: usize, peak: f32, power: f64, samples: Vec<f32> },
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
    /// Whether steady noise is to be recognised, and the recent measurements it is judged from.
    detect_noise: bool,
    recent: VecDeque<(f32, [f32; BANDS])>,
}

// The decoder is only ever used by the one task that owns it.
unsafe impl Send for Detector {}

impl Detector {
    /// `threshold_db` is relative to full scale, e.g. -55.
    pub fn new(codec: Codec, header_rate: u32, threshold_db: f32, detect_noise: bool) -> Self {
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
            detect_noise,
            recent: VecDeque::with_capacity(NOISE_SAMPLES),
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
                self.state = State::Running { bytes: 0, frames: 0, measured: 0, peak: 0.0, power: 0.0, samples: Vec::with_capacity(WANTED_SAMPLES + SPECTRUM) };
            }
            let State::Running { bytes, frames: fed, measured, peak, power, samples } = &mut self.state else { unreachable!() };
            // Only MP3 keeps audio in earlier frames; AAC needs just the overlap.
            let lead_in = *fed < LEAD_FRAMES || (frame.format.codec == Codec::Mp3 && *bytes < LEAD_BYTES);
            *bytes += frame.data.len();
            *fed += 1;

            let mut heard = None;
            if decoder.send_packet(&ffmpeg::Packet::copy(&frame.data)).is_ok() {
                while decoder.receive_frame(&mut self.output).is_ok() {
                    // Samples are only kept from the frames that are measured.
                    let keep = (!lead_in && self.detect_noise && samples.len() < WANTED_SAMPLES).then_some(&mut *samples);
                    let (loudest, mean_square) = measure(&self.output, keep).unwrap_or((0.0, 0.0));
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
            let enough = !self.detect_noise || samples.len() >= WANTED_SAMPLES || *measured >= MAX_MEASURED_FRAMES;
            if *measured >= MEASURED_FRAMES && enough {
                verdict = if *peak >= self.threshold { Verdict::Loud } else { Verdict::Quiet };
                // Is it sound, or only noise? Judged over the last few measurements together.
                let rate = self.decoded.map_or(self.header_rate, |decoded| decoded.sample_rate);
                match (&verdict, spectrum(samples, rate)) {
                    (Verdict::Loud, Some(seen)) => {
                        if self.recent.len() == NOISE_SAMPLES {
                            self.recent.pop_front();
                        }
                        self.recent.push_back(seen);
                        if only_noise(&self.recent) {
                            verdict = Verdict::Noise;
                        }
                    }
                    // A silent moment says nothing either way: hiss that dips and comes back is still hiss.
                    _ => {}
                }
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

/// How evenly a stretch of audio spreads its energy over the spectrum
/// (0 a pure tone, 1 white noise), and the share of it in each band, in dB.
/// `None` if there is too little audio or none of it is in the bands.
fn spectrum(samples: &[f32], rate: u32) -> Option<(f32, [f32; BANDS])> {
    if samples.len() < SPECTRUM || rate == 0 {
        return None;
    }
    let mut power = vec![0f32; SPECTRUM / 2];
    for window in samples.chunks_exact(SPECTRUM).take(2) {
        let mut re: Vec<f32> = window
            .iter()
            .enumerate()
            // A Hann window, so that the cut at each end does not smear the spectrum.
            .map(|(i, sample)| sample * (0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (SPECTRUM - 1) as f32).cos()))
            .collect();
        let mut im = vec![0f32; SPECTRUM];
        fft(&mut re, &mut im);
        for (bin, value) in power.iter_mut().enumerate() {
            *value += re[bin] * re[bin] + im[bin] * im[bin];
        }
    }
    // Nothing above 90% of the highest frequency the stream can carry is looked at.
    let top = rate as f32 * 0.45;
    let bin = |hz: f32| ((hz.min(top) * SPECTRUM as f32 / rate as f32) as usize).min(SPECTRUM / 2);

    let range = &power[bin(FLATNESS_RANGE.0)..bin(FLATNESS_RANGE.1)];
    if range.len() < 16 {
        return None;
    }
    let mean = range.iter().sum::<f32>() / range.len() as f32;
    if mean <= 0.0 {
        return None;
    }
    let log_mean = range.iter().map(|value| (value + 1e-12).ln()).sum::<f32>() / range.len() as f32;
    let flatness = log_mean.exp() / mean;

    let mut bands = [0f32; BANDS];
    for (band, edges) in BAND_EDGES.windows(2).enumerate() {
        bands[band] = power[bin(edges[0])..bin(edges[1])].iter().sum::<f32>();
    }
    let total: f32 = bands.iter().sum();
    if total <= 0.0 {
        return None;
    }
    // A band the stream cannot carry at all stays far below the others and is ignored.
    Some((flatness, bands.map(|band| 10.0 * (band / total + 1e-9).log10())))
}

/// Whether a run of measurements is nothing but steady noise: every one
/// pitchless, and no band's share of the spectrum moving.
fn only_noise(recent: &VecDeque<(f32, [f32; BANDS])>) -> bool {
    if recent.len() < NOISE_SAMPLES || recent.iter().any(|(flatness, _)| *flatness < NOISE_FLATNESS) {
        return false;
    }
    (0..BANDS).all(|band| {
        let (low, high) = recent.iter().fold((f32::MAX, f32::MIN), |(low, high), (_, shape)| (low.min(shape[band]), high.max(shape[band])));
        // A band holding next to nothing is all rounding, and is left out.
        high < -25.0 || high - low <= NOISE_MOVEMENT_DB
    })
}

/// A plain radix-2 fast Fourier transform, in place. The length is a power of two.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let angle = -2.0 * std::f32::consts::PI / len as f32;
        let (step_re, step_im) = (angle.cos(), angle.sin());
        for start in (0..n).step_by(len) {
            let (mut w_re, mut w_im) = (1f32, 0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let (t_re, t_im) = (re[b] * w_re - im[b] * w_im, re[b] * w_im + im[b] * w_re);
                re[b] = re[a] - t_re;
                im[b] = im[a] - t_im;
                re[a] += t_re;
                im[a] += t_im;
                (w_re, w_im) = (w_re * step_re - w_im * step_im, w_re * step_im + w_im * step_re);
            }
        }
        len <<= 1;
    }
}

/// The largest sample in a decoded frame, as a fraction of full scale, and the
/// mean of its squared samples (its power). The first channel's samples are
/// added to `keep` when it is given, for the spectrum.
fn measure(frame: &ffmpeg::frame::Audio, mut keep: Option<&mut Vec<f32>>) -> Option<(f32, f64)> {
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
    // In a packed frame the channels alternate; in a planar one each has its own plane.
    let stride = if planes == 1 { channels } else { 1 };
    let mut note = |value: f32, first_channel: bool| {
        peak = peak.max(value.abs());
        squares += (value as f64) * (value as f64);
        count += 1;
        if first_channel {
            if let Some(kept) = keep.as_deref_mut() {
                kept.push(value);
            }
        }
    };
    for plane in 0..planes {
        let data = frame.data(plane);
        match frame.format() {
            Sample::F32(_) => {
                for (i, value) in data.chunks_exact(4).take(per_plane).enumerate() {
                    note(f32::from_ne_bytes([value[0], value[1], value[2], value[3]]), plane == 0 && i % stride == 0);
                }
            }
            Sample::I16(_) => {
                for (i, value) in data.chunks_exact(2).take(per_plane).enumerate() {
                    note(i16::from_ne_bytes([value[0], value[1]]) as f32 / 32768.0, plane == 0 && i % stride == 0);
                }
            }
            Sample::I32(_) => {
                for (i, value) in data.chunks_exact(4).take(per_plane).enumerate() {
                    note(i32::from_ne_bytes([value[0], value[1], value[2], value[3]]) as f32 / 2_147_483_648.0, plane == 0 && i % stride == 0);
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

    struct Heard {
        loud: u32,
        quiet: u32,
        noise: u32,
        decoded: Option<Decoded>,
    }

    /// Runs a file through the detector as a live stream would be: one
    /// measurement, then half a second of the stream passes unheard.
    fn listen(name: &str, threshold_db: f32, detect_noise: bool) -> Option<Heard> {
        let dir = std::env::var("TEST_AUDIO_DIR").ok()?;
        let data = std::fs::read(format!("{dir}/{name}")).ok()?;
        let mut frames = Vec::new();
        let mut framer = Framer::new();
        for piece in data.chunks(1500) {
            framer.push(piece, &mut frames);
        }
        let mut detector = Detector::new(frames[0].format.codec, frames[0].format.sample_rate, threshold_db, detect_noise);
        detector.interval = Duration::ZERO;
        let mut heard = Heard { loud: 0, quiet: 0, noise: 0, decoded: None };
        let started = std::time::Instant::now();
        let mut skip = 0u64;
        for frame in &frames {
            if skip > 0 {
                skip = skip.saturating_sub(frame.duration_us);
                continue;
            }
            match detector.feed(std::slice::from_ref(frame)) {
                Verdict::Pending => continue,
                Verdict::Loud => heard.loud += 1,
                Verdict::Quiet => heard.quiet += 1,
                Verdict::Noise => heard.noise += 1,
                Verdict::Unavailable => panic!("{name}: no decoder"),
            }
            skip = 400_000;
        }
        let each = started.elapsed().as_secs_f64() * 1e6 / (heard.loud + heard.quiet + heard.noise).max(1) as f64;
        println!("{name}: {} loud, {} quiet, {} noise, level {:?} dB, {each:.0} us per measurement", heard.loud, heard.quiet, heard.noise, detector.level_db());
        heard.decoded = detector.decoded;
        Some(heard)
    }

    #[test]
    fn hears_the_difference() {
        let Some(tone) = listen("tone.mp3", -55.0, true) else { return };
        assert!(tone.loud > 15 && tone.quiet == 0 && tone.noise == 0, "a tone is audio");
        assert_eq!(tone.decoded, Some(Decoded { sample_rate: 44100, channels: 2, he_aac: false }));

        for name in ["silence.mp3", "silence.aac"] {
            let heard = listen(name, -55.0, true).unwrap();
            assert!(heard.quiet > 10 && heard.loud == 0, "{name}: digital silence");
        }
        let aac = listen("tone.aac", -55.0, false).unwrap();
        assert!(aac.loud > 15 && aac.quiet == 0);

        // Hiss at about -60 dB: silence at the usual threshold.
        for name in ["hiss.mp3", "hiss.aac"] {
            let heard = listen(name, -55.0, true).unwrap();
            assert!(heard.quiet > 10 && heard.loud == 0 && heard.noise == 0, "{name}: quiet hiss is silence");
            // Counted as loud by someone who sets the threshold below it and does not look for noise...
            let heard = listen(name, -80.0, false).unwrap();
            assert!(heard.loud > 10 && heard.noise == 0, "{name}: heard at -80 dB");
        }
        // Low-bitrate MP3 keeps more of each frame in the frames before it.
        if let Some(low) = listen("tone-32k.mp3", -55.0, false) {
            assert!(low.loud > 10 && low.quiet == 0);
        }
    }

    #[test]
    fn steady_noise_is_recognised_whatever_its_level() {
        // Loud hiss: well above the silence threshold, and still nothing to listen to.
        for name in ["loud-hiss.mp3", "loud-hiss.aac", "station-hiss.aac"] {
            let Some(heard) = listen(name, -55.0, true) else { continue };
            // The first measurements are "loud" until there are enough of them to judge.
            assert!(heard.loud < NOISE_SAMPLES as u32, "{name}: {} loud", heard.loud);
            assert!(heard.noise >= 10, "{name}: recognised as noise ({} times)", heard.noise);
        }
        // Programme is never taken for noise.
        for name in ["music.mp3", "music2.mp3", "jazz.mp3", "classical.mp3", "speech.mp3", "tone.mp3"] {
            let Some(heard) = listen(name, -55.0, true) else { continue };
            assert_eq!(heard.noise, 0, "{name} is programme, not noise");
            assert!(heard.loud > 10, "{name}");
        }
    }

    #[test]
    fn the_spectrum_tells_a_tone_from_noise() {
        let tone: Vec<f32> = (0..WANTED_SAMPLES).map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 44100.0).sin() * 0.5).collect();
        let (flatness, shape) = spectrum(&tone, 44100).unwrap();
        assert!(flatness < 0.01, "a tone is all pitch: {flatness}");
        assert!(shape[1] > -1.0 && shape[4] < -30.0, "its energy is in the 800-1600 Hz band: {shape:?}");

        // Noise from a simple generator: no pitch, and the same shape every time.
        let mut seed = 12345u32;
        let mut noise = || {
            (0..WANTED_SAMPLES)
                .map(|_| {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (seed >> 8) as f32 / 8_388_608.0 - 1.0
                })
                .collect::<Vec<f32>>()
        };
        let mut recent = VecDeque::new();
        for _ in 0..NOISE_SAMPLES {
            let seen = spectrum(&noise(), 44100).unwrap();
            assert!(seen.0 > 0.4, "white noise is flat: {}", seen.0);
            recent.push_back(seen);
        }
        assert!(only_noise(&recent));
        // One tonal moment among them and it is programme.
        recent[5] = (flatness, shape);
        assert!(!only_noise(&recent));
        // Too little audio says nothing.
        assert!(spectrum(&tone[..1000], 44100).is_none());
    }
}
