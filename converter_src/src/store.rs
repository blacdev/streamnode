//! What the program remembers and the queue of work.
//!
//! *Targets* are what files are converted to: a stream whose format was
//! detected, or the user's own settings. They are saved between runs. *Jobs*
//! are files being converted; they last only as long as the window is open.
//! One worker thread converts one file at a time and sleeps when there is
//! nothing to do.

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
};

use serde::{Deserialize, Serialize};

use crate::media::{self, Settings, StreamFormat};

/// How loud converted files are made.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub enum Level {
    /// As loud as the file already is.
    Keep,
    /// As loud as the stream was heard to be.
    Stream,
    /// A level of the user's choosing, in dB below full scale.
    Fixed(f32),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Check {
    #[default]
    Idle,
    Detecting,
    Failed(String),
}

/// The id of the target that has no stream: the user's own settings.
pub const OWN: u64 = 0;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Target {
    pub id: u64,
    pub name: String,
    /// Empty for the user's own settings.
    pub url: String,
    pub format: Option<StreamFormat>,
    pub settings: Settings,
    pub level: Level,
    /// The settings were changed by hand, so a new detection leaves them alone.
    pub changed: bool,
    /// Where converted files go; `None` puts each beside its original.
    pub out_dir: Option<PathBuf>,
    #[serde(skip)]
    pub check: Check,
    /// Stops a detection that is under way.
    #[serde(skip)]
    pub cancel: Arc<AtomicBool>,
}

impl Target {
    pub fn own() -> Self {
        Self {
            id: OWN,
            name: "Your own settings".into(),
            url: String::new(),
            format: None,
            settings: Settings { kind: "mp3".into(), bitrate_kbps: 128, sample_rate: 44100, channels: 2, level_db: None },
            level: Level::Keep,
            changed: false,
            out_dir: None,
            check: Check::Idle,
            cancel: Arc::default(),
        }
    }

    pub fn is_stream(&self) -> bool {
        !self.url.is_empty()
    }

    /// The settings that reproduce a stream's format, as nearly as can be made.
    pub fn matching(format: &StreamFormat) -> Settings {
        let kind = format.kind().unwrap_or("mp3");
        let fallback = if kind == "aac" { 96 } else { 128 };
        Settings { kind: kind.into(), bitrate_kbps: format.bitrate_kbps.unwrap_or(fallback), sample_rate: format.sample_rate, channels: format.channels, level_db: None }
    }

    /// Whether the settings are exactly the stream's format.
    pub fn matches_stream(&self) -> bool {
        self.format.as_ref().is_some_and(|format| Self::matching(format) == self.settings && !format.he_aac() && format.kind().is_some())
    }

    /// The settings a file added now is converted with.
    pub fn job_settings(&self) -> Result<Settings, String> {
        let level_db = match self.level {
            Level::Keep => None,
            Level::Stream => self.format.as_ref().and_then(|format| format.level_db),
            Level::Fixed(db) => Some(db),
        };
        Settings { level_db, ..self.settings.clone() }.checked()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum JobState {
    Waiting,
    /// How far along, from 0 to 1.
    Working(f32),
    Done { output: PathBuf, gain_db: f32 },
    Failed(String),
}

#[derive(Clone, Debug)]
pub struct Job {
    pub id: u64,
    pub target: u64,
    pub input: PathBuf,
    pub state: JobState,
    pub settings: Settings,
    /// Added to the file's name when the plain name is taken.
    pub label: String,
    pub out_dir: Option<PathBuf>,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct State {
    pub targets: Vec<Target>,
    pub jobs: Vec<Job>,
    pub next_id: u64,
    /// The targets changed and have not been saved yet.
    pub unsaved: bool,
}

impl State {
    pub fn new_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    pub fn target(&mut self, id: u64) -> Option<&mut Target> {
        self.targets.iter_mut().find(|target| target.id == id)
    }
}

pub struct Shared {
    pub state: Mutex<State>,
    wake: Condvar,
    /// Asks the window to redraw; set once the window exists.
    repaint: Box<dyn Fn() + Send + Sync>,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    targets: Vec<Target>,
    next_id: u64,
}

fn config_file() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)?
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|path| path.is_absolute()).or_else(|| Some(PathBuf::from(std::env::var_os("HOME")?).join(".config")))?
    };
    Some(base.join(if cfg!(windows) { "StreamNode Converter" } else { "streamnode-converter" }).join("config.json"))
}

impl Shared {
    /// Loads what was saved and starts the worker.
    pub fn start(repaint: impl Fn() + Send + Sync + 'static) -> Arc<Self> {
        let saved: Saved = config_file().and_then(|path| std::fs::read(path).ok()).and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        let mut targets = saved.targets;
        if !targets.iter().any(|target| target.id == OWN) {
            targets.insert(0, Target::own());
        }
        let next_id = targets.iter().map(|target| target.id).max().unwrap_or(0).max(saved.next_id);
        let shared = Arc::new(Self { state: Mutex::new(State { targets, jobs: Vec::new(), next_id, unsaved: false }), wake: Condvar::new(), repaint: Box::new(repaint) });
        let worker = shared.clone();
        thread::Builder::new().name("convert".into()).spawn(move || worker.work()).expect("cannot start the worker");
        shared
    }

    pub fn save(&self) {
        let Some(path) = config_file() else { return };
        let saved = {
            let mut state = self.state.lock().unwrap();
            state.unsaved = false;
            Saved { targets: state.targets.clone(), next_id: state.next_id }
        };
        if let (Some(dir), Ok(json)) = (path.parent(), serde_json::to_vec_pretty(&saved)) {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(path, json);
        }
    }

    /// Finds out a stream's format in the background.
    pub fn detect(self: &Arc<Self>, id: u64) {
        let (url, cancel) = {
            let mut state = self.state.lock().unwrap();
            let Some(target) = state.target(id).filter(|target| target.is_stream()) else { return };
            target.cancel.store(true, Ordering::Relaxed);
            target.cancel = Arc::default();
            target.check = Check::Detecting;
            (target.url.clone(), target.cancel.clone())
        };
        let shared = self.clone();
        thread::spawn(move || {
            let found = media::detect(&url, &cancel);
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let mut state = shared.state.lock().unwrap();
            if let Some(target) = state.target(id) {
                match found {
                    Ok(format) => {
                        if !target.changed {
                            target.settings = Target::matching(&format);
                            // A stream whose level is known is worth matching; that is why it was listened to.
                            target.level = if format.level_db.is_some() { Level::Stream } else { Level::Keep };
                        }
                        target.format = Some(format);
                        target.check = Check::Idle;
                    }
                    Err(reason) => target.check = Check::Failed(reason),
                }
                state.unsaved = true;
            }
            drop(state);
            (shared.repaint)();
        });
    }

    /// Queues files for a target. Returns why not, if its settings are not usable.
    pub fn add_files(&self, target: u64, files: Vec<PathBuf>) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let Some(found) = state.target(target) else { return Ok(()) };
        let settings = found.job_settings()?;
        let (label, out_dir) = (if found.is_stream() { found.name.clone() } else { "converted".to_string() }, found.out_dir.clone());
        for input in files {
            let id = state.new_id();
            state.jobs.push(Job { id, target, input, state: JobState::Waiting, settings: settings.clone(), label: label.clone(), out_dir: out_dir.clone(), cancel: Arc::default() });
        }
        drop(state);
        self.wake.notify_one();
        Ok(())
    }

    /// Stops everything under way; called as the window closes, so that no
    /// conversion is left running with nobody to see it.
    pub fn stop_all(&self) {
        let mut state = self.state.lock().unwrap();
        state.jobs.drain(..).for_each(|job| job.cancel.store(true, Ordering::Relaxed));
        state.targets.iter().for_each(|target| target.cancel.store(true, Ordering::Relaxed));
    }

    /// Takes a job off the list, stopping it if it is being converted.
    pub fn remove_job(&self, id: u64) {
        let mut state = self.state.lock().unwrap();
        if let Some(at) = state.jobs.iter().position(|job| job.id == id) {
            state.jobs.remove(at).cancel.store(true, Ordering::Relaxed);
        }
    }

    fn set(&self, id: u64, new: JobState) {
        let mut state = self.state.lock().unwrap();
        if let Some(job) = state.jobs.iter_mut().find(|job| job.id == id) {
            job.state = new;
        }
        drop(state);
        (self.repaint)();
    }

    fn work(&self) {
        loop {
            let job = {
                let mut state = self.state.lock().unwrap();
                loop {
                    if let Some(job) = state.jobs.iter_mut().find(|job| job.state == JobState::Waiting) {
                        job.state = JobState::Working(0.0);
                        break job.clone();
                    }
                    // Nothing to do: sleep until a file is added.
                    state = self.wake.wait(state).unwrap();
                }
            };
            (self.repaint)();
            let extension = media::kind(&job.settings.kind).map_or("out", |kind| kind.extension);
            let dir = job.out_dir.clone().or_else(|| job.input.parent().map(Path::to_path_buf)).unwrap_or_default();
            let output = output_path(&job.input, &dir, extension, &job.label, |path| path.exists());
            // Written under another name first, so a half-made file is never mistaken for a finished one.
            let part = output.with_extension(format!("{extension}.part"));
            let mut shown = 0.0;
            let result = std::fs::create_dir_all(&dir).map_err(|error| format!("The folder to save into could not be used ({error}).")).and_then(|()| {
                media::convert(&job.input, &part, &job.settings, &job.cancel, |done| {
                    // The window is redrawn for each whole percent, not for every report.
                    if done - shown >= 0.01 {
                        shown = done;
                        self.set(job.id, JobState::Working(done));
                    }
                })
            });
            let finished = result.and_then(|gain_db| std::fs::rename(&part, &output).map(|()| gain_db).map_err(|error| format!("The converted file could not be saved ({error}).")));
            match finished {
                Ok(gain_db) => self.set(job.id, JobState::Done { output, gain_db }),
                Err(reason) => {
                    let _ = std::fs::remove_file(&part);
                    self.set(job.id, JobState::Failed(reason));
                }
            }
        }
    }
}

/// Where a converted file is written: the original's name with the new
/// extension. If that is the original itself, or is taken, `label` is added,
/// and then a number, until the name is free.
pub fn output_path(input: &Path, dir: &Path, extension: &str, label: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let stem = input.file_stem().map(|stem| stem.to_string_lossy().into_owned()).filter(|stem| !stem.is_empty()).unwrap_or_else(|| "audio".into());
    let label: String = label.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()).take(40).collect();
    let label = if label.trim().is_empty() { "converted" } else { label.trim() };
    let free = |path: &Path| path != input && !taken(path);
    let plain = dir.join(format!("{stem}.{extension}"));
    if free(&plain) {
        return plain;
    }
    (1u32..)
        .map(|n| dir.join(if n == 1 { format!("{stem} ({label}).{extension}") } else { format!("{stem} ({label} {n}).{extension}") }))
        .find(|path| free(path))
        .expect("some name is free")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_converted_file_never_replaces_another() {
        let dir = Path::new("/music");
        let none = |_: &Path| false;
        assert_eq!(output_path(Path::new("/music/jingle.wav"), dir, "mp3", "Jazz FM", none), Path::new("/music/jingle.mp3"));
        // The same name as the original: the original is kept.
        assert_eq!(output_path(Path::new("/music/jingle.mp3"), dir, "mp3", "Jazz FM", none), Path::new("/music/jingle (Jazz FM).mp3"));
        let taken = |path: &Path| path == Path::new("/music/jingle.mp3") || path == Path::new("/music/jingle (Jazz FM).mp3");
        assert_eq!(output_path(Path::new("/music/jingle.wav"), dir, "mp3", "Jazz FM", taken), Path::new("/music/jingle (Jazz FM 2).mp3"));
        // A label that could not be part of a file name.
        assert_eq!(output_path(Path::new("/music/a.mp3"), dir, "mp3", "FM: 96/8?", none), Path::new("/music/a (FM 968).mp3"));
        assert_eq!(output_path(Path::new("/music/a.mp3"), dir, "mp3", "  ", none), Path::new("/music/a (converted).mp3"));
    }

    #[test]
    fn settings_follow_the_stream() {
        let format = StreamFormat { codec: "aac".into(), profile: "LC".into(), sample_rate: 48000, channels: 1, bitrate_kbps: None, level_db: Some(-18.0) };
        let mut target = Target { url: "http://x/y".into(), format: Some(format.clone()), settings: Target::matching(&format), level: Level::Stream, ..Target::own() };
        assert_eq!(target.settings, Settings { kind: "aac".into(), bitrate_kbps: 96, sample_rate: 48000, channels: 1, level_db: None });
        assert!(target.matches_stream());
        assert_eq!(target.job_settings().unwrap().level_db, Some(-18.0));
        target.level = Level::Keep;
        assert_eq!(target.job_settings().unwrap().level_db, None);
        target.settings.bitrate_kbps = 64;
        assert!(!target.matches_stream());
        // HE-AAC can be recognised but not made, so nothing matches it exactly.
        let he = StreamFormat { profile: "HE-AAC".into(), ..format };
        let target = Target { format: Some(he.clone()), settings: Target::matching(&he), ..Target::own() };
        assert!(!target.matches_stream());
    }
}
