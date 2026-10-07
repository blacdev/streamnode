//! Station relays.
//!
//! Each station with at least one listener has exactly one relay task holding
//! one connection to the source. Audio is fanned out through a broadcast
//! channel; when the last listener leaves, the relay disconnects from the
//! source after a short grace period.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::{Bytes, BytesMut};
use redis::aio::ConnectionManager;
use tokio::{
    sync::{broadcast, watch},
    time::Instant,
};

use crate::{
    config::Config,
    frames::Format,
    health::AudioHealth,
    nowplaying::{self, NowPlaying},
    playout::RelayTask,
    station::Station,
    upstream::{Connector, StreamInfo},
};

/// Chunks a slow listener may fall behind before it starts skipping audio.
/// How long audio is gathered before it is sent on to listeners, in
/// milliseconds (set from PUBLISH_INTERVAL_MS at start-up).
pub static PUBLISH_INTERVAL_MS: AtomicU64 = AtomicU64::new(400);
/// A piece is sent early once it reaches this size, whatever its age.
const PUBLISH_MAX_BYTES: usize = 64 * 1024;
const CHANNEL_CAPACITY: usize = 512;

#[derive(Clone)]
pub enum Status {
    Connecting,
    Live(Arc<StreamInfo>),
    Failed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    None = 0,
    Primary = 1,
    Backup = 2,
    /// The station's fallback file, played when no live source has audio.
    Fallback = 3,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::None => "none",
            Source::Primary => "primary",
            Source::Backup => "backup",
            Source::Fallback => "fallback",
        }
    }
}

struct Shared {
    /// Dropped when the relay shuts down, which ends every listener stream.
    tx: Option<broadcast::Sender<Bytes>>,
    ring: VecDeque<Bytes>,
    ring_bytes: usize,
    /// Audio gathered since the last piece went out to listeners.
    pending: BytesMut,
    pending_since: Option<Instant>,
}

pub struct Relay {
    pub slug: String,
    pub started_at: u64,
    shared: Mutex<Shared>,
    status: watch::Sender<Status>,
    now_playing: watch::Sender<Arc<NowPlaying>>,
    /// Open listener connections, including those still waiting for the source.
    connections: AtomicUsize,
    /// Listeners actually receiving audio; the figure that is reported.
    listeners: AtomicUsize,
    peak: AtomicUsize,
    bytes: AtomicU64,
    sessions: AtomicU64,
    source: AtomicU8,
    /// Everything known about what is playing; what listeners are shown is worked out from it.
    titles: Mutex<Titles>,
    /// Unix seconds when audio last arrived from the source.
    last_audio: AtomicU64,
    /// The stream's audio format, once a frame of it has been seen.
    format: Mutex<Option<Format>>,
    /// The stream is relayed as it arrives because it cannot be cut into
    /// frames, so nothing can be spliced into it.
    unframed: AtomicBool,
}

/// What a station's owner set to be shown when nothing better is known.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Defaults {
    pub title: String,
    pub artist: String,
    /// The artwork address given for the station.
    pub artwork_url: String,
    /// The station's uploaded image.
    pub image: String,
}

impl Defaults {
    pub(crate) fn of(station: &Station) -> Self {
        Self {
            title: station.default_title.clone().unwrap_or_default(),
            artist: station.default_artist.clone().unwrap_or_default(),
            artwork_url: station.artwork_url.clone().unwrap_or_default(),
            image: station.default_artwork.clone().unwrap_or_default(),
        }
    }
}

/// The sources of a station's title and artwork. In order of preference: what
/// the metadata URL last said, while it is still answering; the title carried
/// in the stream; the station's own defaults. Artwork follows the same idea:
/// the metadata URL's, the station's artwork address, the uploaded image, and
/// an address that was tried and does not work is passed over.
#[derive(Default)]
pub(crate) struct Titles {
    pub defaults: Defaults,
    /// The metadata URL's last answer and the Unix second it has to be renewed by.
    pub external: Option<(NowPlaying, u64)>,
    /// Whether the metadata URL describes what is playing now. It does not
    /// when the backup is a programme of its own.
    pub use_external: bool,
    /// The title last carried in the playing stream.
    pub stream: String,
    /// The name of the fallback file, while it is what is playing.
    pub file: Option<String>,
    /// After a change of source: until when the title on show is kept if the new
    /// source has named nothing yet.
    pub settle_until: Option<tokio::time::Instant>,
    /// Artwork addresses that were tried: whether each one worked, and when it was tried.
    pub checked: HashMap<String, (bool, u64)>,
}

impl Titles {
    /// Whether an artwork address was tried and answered with a picture.
    fn works(&self, url: &str) -> bool {
        !url.is_empty() && self.checked.get(url).is_some_and(|(ok, _)| *ok)
    }

    fn station_artwork(&self) -> String {
        let (url, image) = (&self.defaults.artwork_url, &self.defaults.image);
        // With an image to use instead, the address is shown only once it is known to work.
        // Without one it is not tried at all, and is shown as it was given.
        if self.works(url) || (image.is_empty() && !self.checked.contains_key(url)) {
            url.clone()
        } else {
            image.clone()
        }
    }

    pub(crate) fn shown(&self, now: u64) -> NowPlaying {
        let defaults = &self.defaults;
        // While the file plays, the stream's titles describe audio that is not on air.
        if let Some(file) = &self.file {
            let named = !defaults.title.is_empty() || !defaults.artist.is_empty();
            return NowPlaying {
                title: if named { defaults.title.clone() } else { file.clone() },
                artist: defaults.artist.clone(),
                artwork: self.station_artwork(),
                from: if named { "station" } else { "file" },
            };
        }
        if let Some((external, until)) = self.external.as_ref().filter(|_| self.use_external) {
            if now <= *until && !(external.title.is_empty() && external.artist.is_empty()) {
                let artwork = if self.works(&external.artwork) { external.artwork.clone() } else { self.station_artwork() };
                return NowPlaying { title: external.title.clone(), artist: external.artist.clone(), artwork, from: "metadata_url" };
            }
        }
        let (artist, title) = nowplaying::split_stream_title(&self.stream);
        if !title.is_empty() {
            return NowPlaying { title, artist, artwork: self.station_artwork(), from: "stream" };
        }
        let named = !defaults.title.is_empty() || !defaults.artist.is_empty();
        NowPlaying { title: defaults.title.clone(), artist: defaults.artist.clone(), artwork: self.station_artwork(), from: if named { "station" } else { "" } }
    }
}

pub fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl Relay {
    fn new(station: &Station) -> Self {
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        let titles = Titles { defaults: Defaults::of(station), ..Titles::default() };
        let initial = titles.shown(unix_now());
        Self {
            slug: station.slug.clone(),
            started_at: unix_now(),
            shared: Mutex::new(Shared { tx: Some(tx), ring: VecDeque::new(), ring_bytes: 0, pending: BytesMut::new(), pending_since: None }),
            status: watch::Sender::new(Status::Connecting),
            now_playing: watch::Sender::new(Arc::new(initial)),
            connections: AtomicUsize::new(0),
            listeners: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            bytes: AtomicU64::new(0),
            sessions: AtomicU64::new(0),
            source: AtomicU8::new(Source::None as u8),
            titles: Mutex::new(titles),
            last_audio: AtomicU64::new(0),
            format: Mutex::new(None),
            unframed: AtomicBool::new(false),
        }
    }

    pub fn listeners(&self) -> usize {
        self.listeners.load(Ordering::Relaxed)
    }

    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::Relaxed)
    }

    pub fn source(&self) -> Source {
        match self.source.load(Ordering::Relaxed) {
            1 => Source::Primary,
            2 => Source::Backup,
            3 => Source::Fallback,
            _ => Source::None,
        }
    }

    pub fn status(&self) -> watch::Receiver<Status> {
        self.status.subscribe()
    }

    pub fn now_playing(&self) -> watch::Receiver<Arc<NowPlaying>> {
        self.now_playing.subscribe()
    }

    pub fn current_info(&self) -> Option<Arc<StreamInfo>> {
        match &*self.status.borrow() {
            Status::Live(info) => Some(info.clone()),
            _ => None,
        }
    }

    pub fn last_audio(&self) -> u64 {
        self.last_audio.load(Ordering::Relaxed)
    }

    pub(crate) fn touch_audio(&self) {
        self.last_audio.store(unix_now(), Ordering::Relaxed);
    }

    pub fn format(&self) -> Option<Format> {
        *self.format.lock().unwrap()
    }

    /// Records the stream's format; true when it is new or has changed.
    pub(crate) fn set_format(&self, format: Format) -> bool {
        let mut current = self.format.lock().unwrap();
        if *current == Some(format) {
            return false;
        }
        *current = Some(format);
        true
    }

    pub fn unframed(&self) -> bool {
        self.unframed.load(Ordering::Relaxed)
    }

    /// Notes whether the stream is relayed unframed; true when that is a change.
    pub(crate) fn set_unframed(&self, unframed: bool) -> bool {
        if unframed {
            *self.format.lock().unwrap() = None;
        }
        self.unframed.swap(unframed, Ordering::Relaxed) != unframed
    }

    pub(crate) fn set_source(&self, source: Source) {
        self.source.store(source as u8, Ordering::Relaxed);
    }

    pub(crate) fn set_status(&self, status: Status) {
        self.status.send_replace(status);
    }

    pub fn add_bytes(&self, n: usize) {
        self.bytes.fetch_add(n as u64, Ordering::Relaxed);
    }

    /// Takes the counters accumulated since the previous flush:
    /// `(bytes, sessions, peak listeners)`.
    pub fn take_counters(&self) -> (u64, u64, usize) {
        let now = self.listeners();
        (
            self.bytes.swap(0, Ordering::Relaxed),
            self.sessions.swap(0, Ordering::Relaxed),
            self.peak.swap(now, Ordering::Relaxed).max(now),
        )
    }

    /// Puts counters back after a failed flush so nothing is lost.
    pub fn restore_counters(&self, bytes: u64, sessions: u64, peak: usize) {
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
        self.sessions.fetch_add(sessions, Ordering::Relaxed);
        self.peak.fetch_max(peak, Ordering::Relaxed);
    }

    /// Recent audio plus a receiver for everything after it, taken under one
    /// lock so the two join without a gap. `None` once the relay has shut down.
    pub fn subscribe(&self) -> Option<(VecDeque<Bytes>, broadcast::Receiver<Bytes>)> {
        let shared = self.shared.lock().unwrap();
        let rx = shared.tx.as_ref()?.subscribe();
        Some((shared.ring.clone(), rx))
    }

    /// Hands audio to the listeners. It is gathered into pieces of about
    /// `PUBLISH_INTERVAL_MS` first: every piece sent wakes every listener's
    /// task and costs a write on every connection, so sending the stream in a
    /// few larger pieces a second instead of dozens of small ones is what
    /// keeps the cost per listener low. Players buffer far more than this.
    pub(crate) fn publish(&self, chunk: Bytes, burst_bytes: usize) {
        let mut shared = self.shared.lock().unwrap();
        shared.pending.extend_from_slice(&chunk);
        let since = *shared.pending_since.get_or_insert_with(Instant::now);
        let interval = Duration::from_millis(PUBLISH_INTERVAL_MS.load(Ordering::Relaxed));
        if since.elapsed() < interval && shared.pending.len() < PUBLISH_MAX_BYTES {
            return;
        }
        let chunk = shared.pending.split().freeze();
        shared.pending_since = None;
        shared.ring_bytes += chunk.len();
        shared.ring.push_back(chunk.clone());
        while shared.ring_bytes > burst_bytes && shared.ring.len() > 1 {
            if let Some(old) = shared.ring.pop_front() {
                shared.ring_bytes -= old.len();
            }
        }
        if let Some(tx) = &shared.tx {
            let _ = tx.send(chunk);
        }
    }

    pub(crate) fn close(&self) {
        let mut shared = self.shared.lock().unwrap();
        shared.tx = None;
        shared.pending.clear();
        shared.pending_since = None;
        shared.ring.clear();
        shared.ring_bytes = 0;
    }

    pub(crate) fn set_live(&self, info: StreamInfo, source: Source) {
        self.source.store(source as u8, Ordering::Relaxed);
        self.status.send_replace(Status::Live(Arc::new(info)));
    }

    /// Changes something that is known about what is playing, then shows
    /// listeners whatever now ranks highest.
    pub(crate) fn update_titles(&self, change: impl FnOnce(&mut Titles)) {
        let shown = {
            let mut titles = self.titles.lock().unwrap();
            change(&mut titles);
            let shown = titles.shown(unix_now());
            // Only the wait for a source's first title is bridged; a title it gives is shown at once.
            let waiting = titles.file.is_none() && matches!(shown.from, "station" | "") && titles.settle_until.is_some_and(|until| tokio::time::Instant::now() < until);
            if waiting {
                return;
            }
            titles.settle_until = None;
            shown
        };
        if **self.now_playing.borrow() != shown {
            self.now_playing.send_replace(Arc::new(shown));
        }
    }

    /// Whether an artwork address has been tried, and when; see [`Titles::checked`].
    pub(crate) fn artwork_checked(&self, url: &str) -> Option<(bool, u64)> {
        self.titles.lock().unwrap().checked.get(url).copied()
    }
}

/// Held by a listener for as long as its connection is open.
pub struct ListenerGuard {
    pub relay: Arc<Relay>,
    streaming: bool,
}

impl ListenerGuard {
    /// Called once audio is about to flow: from here on the connection counts
    /// as a listener and as a session in the statistics.
    pub fn start_streaming(&mut self) {
        if !self.streaming {
            self.streaming = true;
            let count = self.relay.listeners.fetch_add(1, Ordering::Relaxed) + 1;
            self.relay.peak.fetch_max(count, Ordering::Relaxed);
            self.relay.sessions.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        if self.streaming {
            self.relay.listeners.fetch_sub(1, Ordering::Relaxed);
        }
        self.relay.connections.fetch_sub(1, Ordering::Relaxed);
    }
}

pub struct StationFull;

pub struct Hub {
    relays: Mutex<HashMap<String, Arc<Relay>>>,
    pub connector: Connector,
    pub redis: ConnectionManager,
    pub cfg: Config,
    /// Other engines currently alive on the same Redis, refreshed with each stats flush.
    peers: Mutex<Vec<String>>,
    /// Whether this engine is able to deliver audio at all.
    pub audio: AudioHealth,
    /// For fetching idents and fallback files from the master. Unlike the
    /// source connector it may reach private addresses: the master is trusted.
    pub internal: reqwest::Client,
    /// Base URL of the master's API; `None` if this engine cannot fetch files.
    pub files_base: Option<String>,
    pub engine_secret: Option<String>,
    /// Stations this engine has given up on for now because their sources
    /// deliver no audio here. They are refused without touching the source.
    silent: Mutex<HashMap<String, Silent>>,
}

/// One station with no audio on this engine.
#[derive(Clone)]
pub struct Silent {
    until: Instant,
    /// Unix seconds when it was given up on.
    pub since: u64,
    pub reason: String,
    /// The sources that failed; edited sources lift the refusal at once.
    sources: (String, Option<String>),
}

impl Hub {
    pub fn new(cfg: Config, redis: ConnectionManager, files_base: Option<String>, engine_secret: Option<String>, insecure: bool) -> Arc<Self> {
        let internal = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .danger_accept_invalid_certs(insecure)
            .build()
            .expect("failed to build the internal HTTP client");
        Arc::new(Self {
            internal,
            files_base,
            engine_secret,
            relays: Mutex::new(HashMap::new()),
            connector: Connector::new(&cfg),
            redis,
            cfg,
            peers: Mutex::new(Vec::new()),
            audio: AudioHealth::new(),
            silent: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn mark_silent(&self, station: &Station, reason: String) {
        let entry = Silent {
            until: Instant::now() + self.cfg.station_retry,
            since: unix_now(),
            reason,
            sources: (station.primary.clone(), station.backup.clone()),
        };
        let mut silent = self.silent.lock().unwrap();
        // Keep the original time while the station stays silent across retries.
        let since = silent.get(&station.slug).map_or(entry.since, |earlier| earlier.since);
        silent.insert(station.slug.clone(), Silent { since, ..entry });
    }

    pub(crate) fn clear_silent(&self, slug: &str) {
        self.silent.lock().unwrap().remove(slug);
    }

    /// True while this engine is refusing the station. The refusal ends when
    /// the retry time passes (the next listener triggers a fresh attempt) or
    /// the station's sources are changed.
    pub fn is_silent(&self, station: &Station) -> bool {
        let silent = self.silent.lock().unwrap();
        silent.get(&station.slug).is_some_and(|entry| {
            entry.until > Instant::now() && entry.sources == (station.primary.clone(), station.backup.clone())
        })
    }

    /// Stations currently without audio here, for the heartbeat. An entry is
    /// reported a little past its retry time so it does not flicker between
    /// attempts; a station nobody asks for any more drops off.
    pub fn silent_stations(&self) -> Vec<(String, Silent)> {
        let mut silent = self.silent.lock().unwrap();
        let linger = self.cfg.station_retry;
        silent.retain(|_, entry| entry.until + linger > Instant::now());
        silent.iter().map(|(slug, entry)| (slug.clone(), entry.clone())).collect()
    }

    pub fn peers(&self) -> Vec<String> {
        self.peers.lock().unwrap().clone()
    }

    pub fn set_peers(&self, peers: Vec<String>) {
        *self.peers.lock().unwrap() = peers;
    }

    /// Registers a listener, starting the station's relay if it is not running.
    /// `elsewhere` is the station's listener count on the other engines, so a
    /// listener limit holds across all of them.
    pub fn acquire(self: &Arc<Self>, station: &Station, elsewhere: usize) -> Result<ListenerGuard, StationFull> {
        let mut relays = self.relays.lock().unwrap();
        let relay = match relays.get(&station.slug) {
            Some(relay) => relay.clone(),
            None => {
                let relay = Arc::new(Relay::new(station));
                relays.insert(station.slug.clone(), relay.clone());
                tokio::spawn(RelayTask::new(self.clone(), relay.clone(), station.clone()).run());
                relay
            }
        };
        if station.max_listeners > 0 && relay.connections() + elsewhere >= station.max_listeners {
            return Err(StationFull);
        }
        relay.connections.fetch_add(1, Ordering::Relaxed);
        Ok(ListenerGuard { relay, streaming: false })
    }

    pub fn get(&self, slug: &str) -> Option<Arc<Relay>> {
        self.relays.lock().unwrap().get(slug).cloned()
    }

    pub fn snapshot(&self) -> Vec<Arc<Relay>> {
        self.relays.lock().unwrap().values().cloned().collect()
    }

    /// Removes the relay unless a listener arrived in the meantime. Listener
    /// registration takes the same lock, so the check cannot race.
    pub(crate) fn remove_if_idle(&self, relay: &Arc<Relay>) -> bool {
        let mut relays = self.relays.lock().unwrap();
        if relay.connections() > 0 {
            return false;
        }
        if relays.get(&relay.slug).is_some_and(|r| Arc::ptr_eq(r, relay)) {
            relays.remove(&relay.slug);
        }
        true
    }

    pub(crate) fn remove(&self, relay: &Arc<Relay>) {
        let mut relays = self.relays.lock().unwrap();
        if relays.get(&relay.slug).is_some_and(|r| Arc::ptr_eq(r, relay)) {
            relays.remove(&relay.slug);
        }
    }
}

#[cfg(test)]
mod title_tests {
    use super::*;

    fn np(title: &str, artist: &str, artwork: &str, from: &'static str) -> NowPlaying {
        NowPlaying { title: title.into(), artist: artist.into(), artwork: artwork.into(), from }
    }

    fn external(title: &str, artist: &str, artwork: &str, until: u64) -> Option<(NowPlaying, u64)> {
        Some((np(title, artist, artwork, "metadata_url"), until))
    }

    /// A station with everything set, playing its primary, whose artwork address works.
    fn titles() -> Titles {
        let defaults = Defaults { title: "Jazz FM".into(), artist: "All day".into(), artwork_url: "http://a/logo.png".into(), image: "http://gw/art".into() };
        let mut titles = Titles { defaults, use_external: true, ..Titles::default() };
        titles.checked.insert("http://a/logo.png".into(), (true, 90));
        titles
    }

    #[test]
    fn defaults_are_shown_until_something_better_is_known() {
        let mut titles = titles();
        assert_eq!(titles.shown(100), np("Jazz FM", "All day", "http://a/logo.png", "station"));
        titles.stream = "Miles Davis - So What".into();
        assert_eq!(titles.shown(100), np("So What", "Miles Davis", "http://a/logo.png", "stream"));
        titles.stream = "Morning show".into();
        assert_eq!(titles.shown(100), np("Morning show", "", "http://a/logo.png", "stream"));
        titles.external = external("So What", "Miles Davis", "http://a/cover.jpg", 130);
        titles.checked.insert("http://a/cover.jpg".into(), (true, 90));
        assert_eq!(titles.shown(100), np("So What", "Miles Davis", "http://a/cover.jpg", "metadata_url"));
    }

    #[test]
    fn a_metadata_url_that_stopped_answering_gives_way() {
        let mut titles = titles();
        titles.external = external("So What", "Miles Davis", "", 130);
        assert_eq!(titles.shown(130), np("So What", "Miles Davis", "http://a/logo.png", "metadata_url"));
        assert_eq!(titles.shown(131), np("Jazz FM", "All day", "http://a/logo.png", "station"));
        titles.stream = "From the stream".into();
        assert_eq!(titles.shown(131).title, "From the stream");
    }

    #[test]
    fn a_backup_with_its_own_programme_shows_its_own_titles() {
        let mut titles = titles();
        titles.external = external("Primary song", "Primary artist", "", 500);
        titles.use_external = false;
        titles.stream = "Backup artist - Backup song".into();
        assert_eq!(titles.shown(100), np("Backup song", "Backup artist", "http://a/logo.png", "stream"));
        // Nothing in the backup's stream: the station's own, never the primary's.
        titles.stream.clear();
        assert_eq!(titles.shown(100), np("Jazz FM", "All day", "http://a/logo.png", "station"));
        // A backup that mirrors the primary is described by the same address.
        titles.use_external = true;
        assert_eq!(titles.shown(100).title, "Primary song");
    }

    #[test]
    fn artwork_is_shown_only_once_it_is_known_to_work() {
        let mut titles = titles();
        titles.external = external("So What", "", "http://a/cover.jpg", 130);
        // Not tried yet, then tried and failed: the station's artwork address either way.
        assert_eq!(titles.shown(100).artwork, "http://a/logo.png");
        titles.checked.insert("http://a/cover.jpg".into(), (false, 90));
        assert_eq!(titles.shown(100).artwork, "http://a/logo.png");
        titles.checked.insert("http://a/logo.png".into(), (false, 90));
        assert_eq!(titles.shown(100).artwork, "http://gw/art");
        titles.checked.remove("http://a/logo.png");
        assert_eq!(titles.shown(100).artwork, "http://gw/art");
        titles.checked.insert("http://a/logo.png".into(), (true, 95));
        assert_eq!(titles.shown(100).artwork, "http://a/logo.png");
        // No address at all: the uploaded image.
        titles.defaults.artwork_url.clear();
        titles.external = None;
        assert_eq!(titles.shown(100).artwork, "http://gw/art");
        // An address and no image to use instead: shown as given, since it is never tried.
        titles.defaults = Defaults { artwork_url: "http://a/other.png".into(), ..Defaults::default() };
        assert_eq!(titles.shown(100).artwork, "http://a/other.png");
    }

    #[test]
    fn the_fallback_file_shows_the_station_defaults() {
        let mut titles = titles();
        titles.stream = "Old stream title".into();
        titles.external = external("Old", "Old", "", 500);
        titles.file = Some("Night mix".into());
        assert_eq!(titles.shown(100), np("Jazz FM", "All day", "http://a/logo.png", "station"));
        // With nothing set for the station, the file's name is all there is.
        titles.defaults = Defaults::default();
        assert_eq!(titles.shown(100), np("Night mix", "", "", "file"));
    }
}
