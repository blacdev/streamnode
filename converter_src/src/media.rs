//! Everything that touches ffmpeg: finding out what a stream or a file is,
//! and converting a file.
//!
//! The work is done by the `ffmpeg` program, which ships beside this one. It
//! is run at the lowest priority and on one thread, so that a conversion
//! never takes more than one processor core and gives way to anything else on
//! the computer. While nothing is being converted, nothing runs at all.

use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

/// How long a stream is listened to for its loudness.
const LISTEN_SECS: u32 = 8;
/// Loudness is matched by this much at most, either way.
const MAX_GAIN_DB: f32 = 20.0;
/// The kinds of file that are opened. Playlists and other formats that can
/// point at further files are left out on purpose.
const FILE_FORMATS: &str = "mp3,aac,wav,flac,ogg,mov,matroska,webm,aiff,w64,avi,asf,flv,mpegts,mpeg,ac3,eac3,amr,caf,au,wv,ape,dsf,tta,mpc,mpc8,oma,rm,gxf,mxf,nut,voc,sox";
const NETWORK: &[&str] = &["-protocol_whitelist", "http,https,tcp,tls,crypto", "-user_agent", "StreamNode-Converter/1.0", "-rw_timeout", "10000000"];

/// What an output can be, and how each is made.
pub struct Kind {
    pub key: &'static str,
    pub label: &'static str,
    pub extension: &'static str,
    /// Lossless and uncompressed formats have no bitrate to choose.
    pub has_bitrate: bool,
    encoder: &'static [&'static str],
    muxer: &'static str,
    /// Sample rates the encoder accepts; empty for any.
    rates: &'static [u32],
}

pub const KINDS: &[Kind] = &[
    Kind { key: "mp3", label: "MP3", extension: "mp3", has_bitrate: true, encoder: &["-c:a", "libmp3lame", "-write_xing", "0", "-id3v2_version", "0"], muxer: "mp3", rates: &[8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000] },
    Kind { key: "aac", label: "AAC (.aac, for streams)", extension: "aac", has_bitrate: true, encoder: &["-c:a", "aac"], muxer: "adts", rates: &[] },
    Kind { key: "m4a", label: "AAC in M4A", extension: "m4a", has_bitrate: true, encoder: &["-c:a", "aac", "-movflags", "+faststart"], muxer: "ipod", rates: &[] },
    Kind { key: "ogg", label: "Ogg Vorbis", extension: "ogg", has_bitrate: true, encoder: &["-c:a", "libvorbis"], muxer: "ogg", rates: &[] },
    Kind { key: "opus", label: "Opus", extension: "opus", has_bitrate: true, encoder: &["-c:a", "libopus"], muxer: "ogg", rates: &[8000, 12000, 16000, 24000, 48000] },
    Kind { key: "flac", label: "FLAC (lossless)", extension: "flac", has_bitrate: false, encoder: &["-c:a", "flac"], muxer: "flac", rates: &[] },
    Kind { key: "wav", label: "WAV (uncompressed)", extension: "wav", has_bitrate: false, encoder: &["-c:a", "pcm_s16le"], muxer: "wav", rates: &[] },
];

pub fn kind(key: &str) -> Option<&'static Kind> {
    KINDS.iter().find(|kind| kind.key == key)
}

/// What a stream was found to be.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StreamFormat {
    pub codec: String,
    pub profile: String,
    pub sample_rate: u32,
    pub channels: u8,
    pub bitrate_kbps: Option<u32>,
    /// Average level, in dB below full scale, over a few seconds of listening.
    pub level_db: Option<f32>,
}

impl StreamFormat {
    /// HE-AAC (AAC+) can be recognised but not made: no encoder for it may be distributed.
    pub fn he_aac(&self) -> bool {
        self.codec == "aac" && self.profile.to_ascii_uppercase().contains("HE")
    }

    /// The output kind that matches this stream, if there is one.
    pub fn kind(&self) -> Option<&'static str> {
        match self.codec.as_str() {
            "mp3" => Some("mp3"),
            "aac" => Some("aac"),
            "vorbis" => Some("ogg"),
            "opus" => Some("opus"),
            "flac" => Some("flac"),
            _ => None,
        }
    }

    pub fn summary(&self) -> String {
        let name = if self.he_aac() { "HE-AAC (AAC+)".to_string() } else { self.codec.to_uppercase() };
        let bitrate = self.bitrate_kbps.map(|kbps| format!(", {kbps} kbps")).unwrap_or_default();
        format!("{name}{bitrate}, {}, {}", khz(self.sample_rate), if self.channels == 1 { "mono" } else { "stereo" })
    }
}

pub fn khz(rate: u32) -> String {
    if rate % 1000 == 0 { format!("{} kHz", rate / 1000) } else { format!("{:.1} kHz", rate as f32 / 1000.0) }
}

/// How a file is to be converted.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub kind: String,
    pub bitrate_kbps: u32,
    pub sample_rate: u32,
    pub channels: u8,
    /// Bring the file's average level to this, in dB below full scale; `None` leaves it as it is.
    pub level_db: Option<f32>,
}

impl Settings {
    /// Checks the values and brings them within what the encoder accepts.
    pub fn checked(mut self) -> Result<Self, String> {
        let kind = kind(&self.kind).ok_or_else(|| format!("\"{}\" is not a format this converter makes.", self.kind))?;
        if !(8000..=192_000).contains(&self.sample_rate) {
            return Err("The sample rate must be between 8,000 and 192,000 Hz.".into());
        }
        if !kind.rates.is_empty() && !kind.rates.contains(&self.sample_rate) {
            // The nearest rate the format allows.
            self.sample_rate = *kind.rates.iter().min_by_key(|rate| rate.abs_diff(self.sample_rate)).unwrap();
        }
        if !(1..=2).contains(&self.channels) {
            return Err("Channels must be 1 (mono) or 2 (stereo).".into());
        }
        if kind.has_bitrate && !(8..=512).contains(&self.bitrate_kbps) {
            return Err("The bitrate must be between 8 and 512 kbps.".into());
        }
        if self.level_db.is_some_and(|db| !(-60.0..=0.0).contains(&db)) {
            return Err("The level must be between -60 and 0 dB.".into());
        }
        Ok(self)
    }

    pub fn summary(&self) -> String {
        let kind = kind(&self.kind).map_or("?", |kind| kind.label);
        let bitrate = if kind_has_bitrate(&self.kind) { format!(", {} kbps", self.bitrate_kbps) } else { String::new() };
        format!("{kind}{bitrate}, {}, {}", khz(self.sample_rate), if self.channels == 1 { "mono" } else { "stereo" })
    }
}

fn kind_has_bitrate(key: &str) -> bool {
    kind(key).is_some_and(|kind| kind.has_bitrate)
}

/// Where the ffmpeg program is: beside this one (how it is shipped), or
/// wherever the system has it.
pub fn ffmpeg() -> &'static Path {
    static FOUND: OnceLock<PathBuf> = OnceLock::new();
    FOUND.get_or_init(|| {
        let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        if let Some(chosen) = std::env::var_os("STREAMNODE_FFMPEG").map(PathBuf::from).filter(|path| path.is_file()) {
            return chosen;
        }
        let beside = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.to_path_buf()));
        beside.into_iter().flat_map(|dir| [dir.join(name), dir.join("ffmpeg").join(name)]).find(|path| path.is_file()).unwrap_or_else(|| PathBuf::from(name))
    })
}

/// Whether ffmpeg can be run at all. Asked once.
pub fn available() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| run(&strings(&["-version"]), Duration::from_secs(15), &AtomicBool::new(false), |_| {}).is_ok_and(|out| out.ok))
}

struct Output {
    ok: bool,
    /// The end of what the program said on its error output.
    stderr: String,
}

/// Starts ffmpeg at the lowest priority, kept to one processor core, and on
/// Windows without a console window.
///
/// ffmpeg runs each stage of its work on a thread of its own, so limiting its
/// codec threads does not keep it to one core; tying the whole process to a
/// single core (the last one) does.
fn spawn(args: &[String]) -> std::io::Result<std::process::Child> {
    let mut command = Command::new(ffmpeg());
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const IDLE_PRIORITY_CLASS: u32 = 0x0000_0040;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(IDLE_PRIORITY_CLASS | CREATE_NO_WINDOW);
    }
    #[cfg(target_os = "linux")]
    // SAFETY: only an async-signal-safe system call runs between fork and exec.
    // It has the converter stopped if this program dies without stopping it.
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    let child = command.spawn()?;
    let last_core = thread::available_parallelism().map_or(0, |cores| cores.get() - 1);
    #[cfg(unix)]
    // SAFETY: plain system calls on the process just started, given a properly
    // sized set; failing only leaves it as it was.
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, child.id() as libc::id_t, 19);
        #[cfg(target_os = "linux")]
        {
            let mut set: libc::cpu_set_t = std::mem::zeroed();
            libc::CPU_SET(last_core.min(libc::CPU_SETSIZE as usize - 1), &mut set);
            libc::sched_setaffinity(child.id() as libc::pid_t, std::mem::size_of::<libc::cpu_set_t>(), &set);
        }
    }
    #[cfg(windows)]
    // SAFETY: the handle is the live child's; failing only leaves it free to use any core.
    unsafe {
        use std::os::windows::io::AsRawHandle;
        windows_sys::Win32::System::Threading::SetProcessAffinityMask(child.as_raw_handle() as _, 1usize << last_core.min(usize::BITS as usize - 1));
    }
    let _ = last_core;
    Ok(child)
}

/// Runs ffmpeg to the end. `on_line` is given each line of its standard
/// output as it arrives. It is stopped when `cancel` is set or `limit` passes.
fn run(args: &[String], limit: Duration, cancel: &AtomicBool, mut on_line: impl FnMut(&str)) -> Result<Output, String> {
    let mut child = spawn(args).map_err(|error| format!("ffmpeg could not be started ({error})"))?;
    let mut stderr = child.stderr.take().expect("piped");
    let errors = thread::spawn(move || {
        let mut tail = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buf[..n]);
            if tail.len() > 32768 {
                tail.drain(..tail.len() - 16384);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let stdout = child.stdout.take().expect("piped");
    let (tx, rx) = mpsc::channel::<String>();
    let lines = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        // Waiting on the channel is what paces this loop: nothing spins.
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => on_line(&line),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break child.wait().map_err(|error| error.to_string())?,
        }
        let stopped = cancel.load(Ordering::Relaxed);
        if stopped || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = lines.join();
            return Err(if stopped { "stopped".into() } else { "it took too long and was stopped".into() });
        }
    };
    let _ = lines.join();
    Ok(Output { ok: status.success(), stderr: errors.join().unwrap_or_default() })
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| arg.to_string()).collect()
}

/// The last thing ffmpeg said, which is usually the reason it gave up.
fn reason(stderr: &str) -> String {
    let line = stderr.lines().rev().map(str::trim).find(|line| !line.is_empty()).unwrap_or("no reason was given");
    line.chars().take(200).collect()
}

/// Only web addresses are ever given to ffmpeg; it could otherwise be asked to read local files.
pub fn check_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let rest = lower.strip_prefix("http://").or_else(|| lower.strip_prefix("https://"));
    match rest {
        Some(rest) if !rest.is_empty() && !url.chars().any(|c| c.is_control() || c.is_whitespace()) && url.len() <= 2000 => Ok(()),
        _ => Err("A stream address starts with http:// or https://".into()),
    }
}

/// What ffmpeg prints about the audio it opened: the first `Audio:` line.
#[derive(Debug, PartialEq)]
struct Described {
    codec: String,
    profile: String,
    sample_rate: u32,
    channels: u8,
    bitrate_kbps: Option<u32>,
    duration_secs: f64,
}

fn describe(stderr: &str) -> Option<Described> {
    let line = stderr.lines().find(|line| line.contains("Stream #") && line.contains("Audio: "))?;
    let audio = &line[line.find("Audio: ")? + 7..];
    let mut parts = audio.split(", ");
    let mut first = parts.next()?.split_whitespace();
    let codec = first.next()?.trim_end_matches(',').to_string();
    // "aac (HE-AAC)" names a profile; "mp3 (mp3float)" only the decoder.
    let profile = first.next().map(|text| text.trim_matches(|c| c == '(' || c == ')').to_string()).filter(|text| text.chars().any(|c| c.is_ascii_uppercase())).unwrap_or_default();
    let (mut sample_rate, mut channels, mut bitrate) = (0, 2, None);
    for part in parts {
        let part = part.trim();
        if let Some(rate) = part.strip_suffix(" Hz").and_then(|n| n.parse().ok()) {
            sample_rate = rate;
        } else if let Some(kbps) = part.split(" kb/s").next().filter(|_| part.contains(" kb/s")).and_then(|n| n.parse().ok()) {
            bitrate = Some(kbps);
        } else if part.starts_with("mono") || part.starts_with("1 channel") {
            channels = 1;
        }
    }
    // What the container or the station says, when the audio line does not.
    let stated = |label: &str| stderr.lines().find_map(|line| line[line.find(label)? + label.len()..].trim_start_matches([' ', ':']).split_whitespace().next()?.parse::<u32>().ok());
    let bitrate = bitrate.or_else(|| stated("bitrate:")).or_else(|| stated("icy-br"));
    let duration_secs = stderr
        .lines()
        .find_map(|line| {
            let clock = line[line.find("Duration: ")? + 10..].split(',').next()?;
            let mut fields = clock.trim().split(':').map(|field| field.parse::<f64>().ok());
            Some(fields.next()?? * 3600.0 + fields.next()?? * 60.0 + fields.next()??)
        })
        .unwrap_or(0.0);
    (sample_rate > 0).then_some(Described { codec, profile, sample_rate, channels, bitrate_kbps: bitrate, duration_secs })
}

/// Connects to a stream, listens for a few seconds, and reports its format and how loud it is.
pub fn detect(url: &str, cancel: &AtomicBool) -> Result<StreamFormat, String> {
    check_url(url)?;
    let mut args = strings(&["-nostdin", "-hide_banner", "-nostats", "-threads", "1"]);
    args.extend(strings(NETWORK));
    args.extend(strings(&["-t", &LISTEN_SECS.to_string(), "-i", url, "-map", "0:a:0", "-vn", "-af", "volumedetect", "-f", "null", "-"]));
    let out = run(&args, Duration::from_secs(LISTEN_SECS as u64 + 30), cancel, |_| {})?;
    let Some(found) = describe(&out.stderr) else {
        return Err(format!("No audio stream was found at that address ({}).", reason(&out.stderr)));
    };
    Ok(StreamFormat {
        codec: found.codec,
        profile: found.profile,
        sample_rate: found.sample_rate,
        channels: found.channels,
        bitrate_kbps: found.bitrate_kbps.filter(|kbps| (8..=2000).contains(kbps)).map(nearest_standard),
        level_db: mean_volume(&out.stderr).filter(|db| *db > -80.0),
    })
}

/// A measured bitrate is a little off the encoder's setting; this is the setting.
fn nearest_standard(kbps: u32) -> u32 {
    const STANDARD: [u32; 17] = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    let nearest = *STANDARD.iter().min_by_key(|step| step.abs_diff(kbps)).unwrap();
    if nearest.abs_diff(kbps) * 20 <= nearest { nearest } else { kbps }
}

fn mean_volume(stderr: &str) -> Option<f32> {
    let at = stderr.rfind("mean_volume:")?;
    stderr[at + 12..].split_whitespace().next()?.parse().ok()
}

fn file_input(path: &Path) -> Vec<String> {
    let mut args = strings(&["-nostdin", "-hide_banner", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file", "-format_whitelist", FILE_FORMATS, "-i"]);
    args.push(path.to_string_lossy().into_owned());
    args
}

/// The shape the audio is brought to before it is measured or encoded. Mixing
/// stereo down to mono changes how loud it is, so the level is taken after this.
fn shape(settings: &Settings) -> String {
    format!("aformat=sample_rates={}:channel_layouts={}", settings.sample_rate, if settings.channels == 1 { "mono" } else { "stereo" })
}

/// How much to turn a file up or down to reach `wanted`, given its own level.
pub fn gain_for(own: f32, wanted: f32) -> f32 {
    if own < -80.0 {
        return 0.0;
    }
    let gain = (wanted - own).clamp(-MAX_GAIN_DB, MAX_GAIN_DB);
    if gain.abs() < 1.0 { 0.0 } else { (gain * 10.0).round() / 10.0 }
}

/// Converts `input` to `output`. `progress` is called with how far along it
/// is, from 0 to 1. Returns the gain that was applied, in dB.
pub fn convert(input: &Path, output: &Path, settings: &Settings, cancel: &AtomicBool, mut progress: impl FnMut(f32)) -> Result<f32, String> {
    let kind = kind(&settings.kind).ok_or("unknown format")?;
    let long = Duration::from_secs(6 * 3600);

    // Opening the file says whether it holds audio and for how long. ffmpeg
    // ends this with an error for want of an output, which is expected.
    let looked = run(&file_input(input), Duration::from_secs(120), cancel, |_| {})?;
    let Some(found) = describe(&looked.stderr) else {
        return Err("No audio was found in this file. It has to be an audio file, or a video with sound.".into());
    };
    let length = found.duration_secs;

    // Measuring first makes the work two passes; each is shown as half the progress.
    let measuring = settings.level_db.is_some();
    let mut gain = 0.0;
    if let Some(wanted) = settings.level_db {
        let mut args = file_input(input);
        args.extend(strings(&["-nostats", "-progress", "pipe:1", "-map", "0:a:0", "-vn", "-af", &format!("{},volumedetect", shape(settings)), "-f", "null", "-"]));
        let out = run(&args, long, cancel, |line| {
            if let Some(done) = written(line, length) {
                progress(done * 0.5);
            }
        })?;
        let own = mean_volume(&out.stderr).filter(|_| out.ok).ok_or_else(|| format!("The audio could not be read to the end ({}).", reason(&out.stderr)))?;
        gain = gain_for(own, wanted);
    }
    // Turned up, peaks are held just under full scale rather than clipped.
    let filter = if gain == 0.0 { shape(settings) } else { format!("{},volume={gain}dB,alimiter=limit=0.9:level=disabled", shape(settings)) };
    let mut args = file_input(input);
    args.extend(strings(&["-v", "error", "-nostats", "-progress", "pipe:1", "-y", "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", &filter]));
    // A file cut into a stream must be nothing but audio; elsewhere tags are worth keeping.
    if matches!(kind.key, "mp3" | "aac") {
        args.extend(strings(&["-map_metadata", "-1"]));
    }
    args.extend(strings(kind.encoder));
    if kind.has_bitrate {
        args.extend(strings(&["-b:a", &format!("{}k", settings.bitrate_kbps)]));
    }
    args.extend(strings(&["-threads", "1", "-f", kind.muxer]));
    args.push(output.to_string_lossy().into_owned());
    let out = run(&args, long, cancel, |line| {
        if let Some(done) = written(line, length) {
            progress(if measuring { 0.5 + done * 0.5 } else { done });
        }
    })?;
    if !out.ok {
        return Err(format!("The file could not be converted ({}).", reason(&out.stderr)));
    }
    Ok(gain)
}

/// How far along a line of ffmpeg's progress report says the work is.
fn written(line: &str, length: f64) -> Option<f32> {
    let micros: f64 = line.strip_prefix("out_time_us=")?.trim().parse().ok()?;
    (length > 0.0).then(|| (micros / 1_000_000.0 / length).clamp(0.0, 1.0) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(kind: &str, rate: u32) -> Settings {
        Settings { kind: kind.into(), bitrate_kbps: 128, sample_rate: rate, channels: 2, level_db: None }
    }

    #[test]
    fn only_web_addresses_are_streams() {
        assert!(check_url("https://radio.example/live").is_ok());
        assert!(check_url("HTTP://radio.example:8000/live.mp3").is_ok());
        for bad in ["file:///etc/passwd", "concat:a|b", "/etc/passwd", "http://", "http://a b", "ftp://x/y", ""] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn settings_are_brought_within_what_the_format_allows() {
        assert_eq!(settings("opus", 44100).checked().unwrap().sample_rate, 48000);
        assert_eq!(settings("mp3", 44100).checked().unwrap().sample_rate, 44100);
        assert_eq!(settings("mp3", 96000).checked().unwrap().sample_rate, 48000);
        assert_eq!(settings("flac", 96000).checked().unwrap().sample_rate, 96000);
        assert!(settings("wma", 44100).checked().is_err());
        assert!(Settings { channels: 6, ..settings("mp3", 44100) }.checked().is_err());
        assert!(Settings { bitrate_kbps: 4, ..settings("mp3", 44100) }.checked().is_err());
        // A lossless format has no bitrate to be wrong.
        assert!(Settings { bitrate_kbps: 0, ..settings("flac", 44100) }.checked().is_ok());
    }

    #[test]
    fn measured_bitrates_snap_to_the_encoder_setting() {
        assert_eq!(nearest_standard(127), 128);
        assert_eq!(nearest_standard(96), 96);
        assert_eq!(nearest_standard(131), 128);
        // Too far from any setting to be one.
        assert_eq!(nearest_standard(144), 144);
    }

    #[test]
    fn loudness_is_matched_within_limits() {
        assert_eq!(gain_for(-24.0, -16.0), 8.0);
        assert_eq!(gain_for(-16.4, -16.0), 0.0);
        assert_eq!(gain_for(-50.0, -10.0), 20.0);
        // Silence is not turned up.
        assert_eq!(gain_for(-91.0, -16.0), 0.0);
    }

    #[test]
    fn stream_formats_are_described_and_matched() {
        let mp3 = StreamFormat { codec: "mp3".into(), profile: String::new(), sample_rate: 44100, channels: 2, bitrate_kbps: Some(96), level_db: None };
        assert_eq!(mp3.summary(), "MP3, 96 kbps, 44.1 kHz, stereo");
        assert_eq!(mp3.kind(), Some("mp3"));
        let he = StreamFormat { codec: "aac".into(), profile: "HE-AAC".into(), sample_rate: 48000, channels: 1, bitrate_kbps: None, level_db: None };
        assert!(he.he_aac());
        assert_eq!(he.summary(), "HE-AAC (AAC+), 48 kHz, mono");
        assert_eq!(mean_volume("[x] n_samples: 1\n[x] mean_volume: -17.3 dB\n[x] max_volume: -1.0 dB"), Some(-17.3));
    }

    #[test]
    fn what_ffmpeg_prints_is_read() {
        let stream = "Input #0, mp3, from 'http://radio.example/live':\n  Metadata:\n    icy-br          : 96\n    icy-name        : Test FM\n  Duration: N/A, start: 0.000000, bitrate: 96 kb/s\n  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 96 kb/s\nOutput #0, null, to 'pipe:':\n  Stream #0:0: Audio: pcm_s16le, 44100 Hz, stereo, s16, 1411 kb/s";
        assert_eq!(describe(stream), Some(Described { codec: "mp3".into(), profile: String::new(), sample_rate: 44100, channels: 2, bitrate_kbps: Some(96), duration_secs: 0.0 }));

        // AAC in a stream does not state its bitrate on the audio line: the station's own figure is used.
        let aac = "Input #0, aac, from 'x':\n  Metadata:\n    icy-br          : 64\n  Duration: N/A, bitrate: N/A\n  Stream #0:0: Audio: aac (HE-AAC), 44100 Hz, stereo, fltp";
        let found = describe(aac).unwrap();
        assert_eq!((found.codec.as_str(), found.profile.as_str(), found.bitrate_kbps), ("aac", "HE-AAC", Some(64)));

        let video = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':\n  Duration: 00:03:25.50, start: 0.000000, bitrate: 1205 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1280x720, 1070 kb/s\n  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 128 kb/s (default)";
        let found = describe(video).unwrap();
        assert_eq!((found.sample_rate, found.channels, found.bitrate_kbps, found.duration_secs), (48000, 1, Some(128), 205.5));

        assert_eq!(describe("Input #0, image2: Stream #0:0: Video: png"), None);
        assert_eq!(written("out_time_us=5000000", 20.0), Some(0.25));
        assert_eq!(written("out_time_us=N/A", 20.0), None);
        assert_eq!(written("out_time_us=5000000", 0.0), None);
    }

    /// Runs ffmpeg for real: makes a file, converts it and reads the result back.
    /// Skipped where ffmpeg is not installed.
    #[test]
    fn files_are_converted_for_real() {
        if !available() {
            eprintln!("ffmpeg not found: skipped");
            return;
        }
        let dir = std::env::temp_dir().join(format!("streamnode-converter-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let never = AtomicBool::new(false);
        let make = |args: &[&str], name: &str| {
            let path = dir.join(name);
            let mut all = strings(&["-v", "error", "-y", "-f", "lavfi"]);
            all.extend(strings(args));
            all.push(path.to_string_lossy().into_owned());
            assert!(run(&all, Duration::from_secs(60), &never, |_| {}).unwrap().ok, "could not make {name}");
            path
        };
        let read = |path: &Path| describe(&run(&file_input(path), Duration::from_secs(30), &never, |_| {}).unwrap().stderr).unwrap();

        // A quiet stereo WAV becomes a mono MP3 at a set bitrate, turned up to the level asked for.
        let wav = make(&["-i", "sine=frequency=440:duration=4", "-af", "volume=-30dB", "-ac", "2", "-ar", "48000"], "tone.wav");
        let mp3 = dir.join("tone.mp3");
        let settings = Settings { kind: "mp3".into(), bitrate_kbps: 96, sample_rate: 44100, channels: 1, level_db: Some(-20.0) };
        let mut steps = Vec::new();
        let gain = convert(&wav, &mp3, &settings, &never, |done| steps.push(done)).unwrap();
        assert!(gain > 5.0, "gain {gain}");
        let made = read(&mp3);
        assert_eq!((made.codec.as_str(), made.sample_rate, made.channels, made.bitrate_kbps), ("mp3", 44100, 1, Some(96)));
        assert!((made.duration_secs - 4.0).abs() < 0.2, "{}", made.duration_secs);
        assert!(steps.windows(2).all(|pair| pair[0] <= pair[1]) && steps.last().is_some_and(|last| *last > 0.9), "{steps:?}");
        // No tag at the start: the file begins with an audio frame, as a stream needs.
        assert_eq!(std::fs::read(&mp3).unwrap()[0], 0xFF);

        // The sound is taken out of a video.
        let video = make(&["-i", "testsrc=duration=2:size=160x120:rate=10", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-shortest", "-pix_fmt", "yuv420p"], "clip.mp4");
        let aac = dir.join("clip.aac");
        let settings = Settings { kind: "aac".into(), bitrate_kbps: 64, sample_rate: 44100, channels: 2, level_db: None };
        assert_eq!(convert(&video, &aac, &settings, &never, |_| {}).unwrap(), 0.0);
        let made = read(&aac);
        assert_eq!((made.codec.as_str(), made.sample_rate, made.channels), ("aac", 44100, 2));

        // Every kind of output can be made.
        for kind in KINDS {
            let out = dir.join(format!("all.{}", kind.extension));
            let settings = Settings { kind: kind.key.into(), bitrate_kbps: 96, sample_rate: 44100, channels: 2, level_db: None }.checked().unwrap();
            convert(&wav, &out, &settings, &never, |_| {}).unwrap_or_else(|reason| panic!("{}: {reason}", kind.key));
            assert!(std::fs::metadata(&out).unwrap().len() > 1000, "{}", kind.key);
        }

        // Something that is not media is refused in plain words, and a stopped job stops.
        let text = dir.join("notes.txt");
        std::fs::write(&text, "not audio").unwrap();
        assert!(convert(&text, &dir.join("x.mp3"), &settings, &never, |_| {}).unwrap_err().starts_with("No audio was found"));
        let stopped = AtomicBool::new(true);
        assert_eq!(convert(&wav, &dir.join("y.mp3"), &settings, &stopped, |_| {}).unwrap_err(), "stopped");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
