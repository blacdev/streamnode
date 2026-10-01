//! Station relays.
//!
//! Each station with at least one listener has exactly one relay task holding
//! one connection to the source. Audio is fanned out through a broadcast
//! channel; when the last listener leaves, the relay disconnects from the
//! source after a short grace period.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use futures_util::StreamExt;
use redis::aio::ConnectionManager;
use tokio::{
    sync::{broadcast, watch},
    task::JoinHandle,
    time::{interval, sleep, Instant, MissedTickBehavior},
};

use crate::{
    config::Config,
    health::AudioHealth,
    icy::IcyDemux,
    nowplaying::{self, NowPlaying},
    station::Station,
    stats,
    upstream::{Connector, StreamInfo, Upstream},
};

/// Chunks a slow listener may fall behind before it starts skipping audio.
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
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::None => "none",
            Source::Primary => "primary",
            Source::Backup => "backup",
        }
    }
}

struct Shared {
    /// Dropped when the relay shuts down, which ends every listener stream.
    tx: Option<broadcast::Sender<Bytes>>,
    ring: VecDeque<Bytes>,
    ring_bytes: usize,
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
    /// Unix seconds of the last successful metadata-URL poll.
    external_meta_at: AtomicU64,
    /// Unix seconds when audio last arrived from the source.
    last_audio: AtomicU64,
}

pub fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl Relay {
    fn new(station: &Station) -> Self {
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        let initial = NowPlaying {
            artwork: station.artwork_url.clone().unwrap_or_default(),
            ..NowPlaying::default()
        };
        Self {
            slug: station.slug.clone(),
            started_at: unix_now(),
            shared: Mutex::new(Shared { tx: Some(tx), ring: VecDeque::new(), ring_bytes: 0 }),
            status: watch::Sender::new(Status::Connecting),
            now_playing: watch::Sender::new(Arc::new(initial)),
            connections: AtomicUsize::new(0),
            listeners: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            bytes: AtomicU64::new(0),
            sessions: AtomicU64::new(0),
            source: AtomicU8::new(Source::None as u8),
            external_meta_at: AtomicU64::new(0),
            last_audio: AtomicU64::new(0),
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

    fn publish(&self, chunk: Bytes, burst_bytes: usize) {
        let mut shared = self.shared.lock().unwrap();
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

    fn clear_burst(&self) {
        let mut shared = self.shared.lock().unwrap();
        shared.ring.clear();
        shared.ring_bytes = 0;
    }

    fn close(&self) {
        let mut shared = self.shared.lock().unwrap();
        shared.tx = None;
        shared.ring.clear();
        shared.ring_bytes = 0;
    }

    fn set_live(&self, info: StreamInfo, source: Source) {
        self.source.store(source as u8, Ordering::Relaxed);
        self.status.send_replace(Status::Live(Arc::new(info)));
    }

    fn set_title(&self, title: String, artist: String, artwork: String) {
        let current = self.now_playing.borrow().clone();
        if current.title != title || current.artist != artist || current.artwork != artwork {
            self.now_playing.send_replace(Arc::new(NowPlaying { title, artist, artwork }));
        }
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
    pub fn new(cfg: Config, redis: ConnectionManager) -> Arc<Self> {
        Arc::new(Self {
            relays: Mutex::new(HashMap::new()),
            connector: Connector::new(&cfg),
            redis,
            cfg,
            peers: Mutex::new(Vec::new()),
            audio: AudioHealth::new(),
            silent: Mutex::new(HashMap::new()),
        })
    }

    fn mark_silent(&self, station: &Station, reason: String) {
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

    fn clear_silent(&self, slug: &str) {
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
    fn remove_if_idle(&self, relay: &Arc<Relay>) -> bool {
        let mut relays = self.relays.lock().unwrap();
        if relay.connections() > 0 {
            return false;
        }
        if relays.get(&relay.slug).is_some_and(|r| Arc::ptr_eq(r, relay)) {
            relays.remove(&relay.slug);
        }
        true
    }

    fn remove(&self, relay: &Arc<Relay>) {
        let mut relays = self.relays.lock().unwrap();
        if relays.get(&relay.slug).is_some_and(|r| Arc::ptr_eq(r, relay)) {
            relays.remove(&relay.slug);
        }
    }
}

enum Flow {
    /// The current source failed; try the other one.
    SourceLost(Source),
    /// The station's source URLs were edited.
    Reconfigured,
    /// No listeners left, or the station was suspended or deleted.
    Stop,
}

struct RelayTask {
    hub: Arc<Hub>,
    relay: Arc<Relay>,
    station: Station,
    idle_since: Option<Instant>,
    last_refresh: Instant,
    last_meta_poll: Option<Instant>,
    /// Why the last source round failed, for the dashboard.
    last_error: String,
}

impl RelayTask {
    fn new(hub: Arc<Hub>, relay: Arc<Relay>, station: Station) -> Self {
        Self { hub, relay, station, idle_since: None, last_refresh: Instant::now(), last_meta_poll: None, last_error: String::new() }
    }

    async fn run(mut self) {
        let slug = self.relay.slug.clone();
        tracing::info!(station = %slug, "relay starting");
        let mut first = Source::Primary;
        let mut backoff = Duration::from_secs(1);
        let mut failed_rounds = 0u32;

        'relay: loop {
            match self.connect_any(first).await {
                Some((upstream, source)) => {
                    self.hub.audio.record_success();
                    self.hub.clear_silent(&slug);
                    failed_rounds = 0;
                    backoff = Duration::from_secs(1);
                    match self.pump(upstream, source).await {
                        Flow::Stop => break,
                        Flow::Reconfigured => first = Source::Primary,
                        Flow::SourceLost(lost) => {
                            self.relay.status.send_replace(Status::Connecting);
                            first = match lost {
                                Source::Primary if self.station.backup.is_some() => Source::Backup,
                                _ => Source::Primary,
                            };
                        }
                    }
                }
                None => {
                    let mut urls = vec![self.station.primary.clone()];
                    urls.extend(self.station.backup.clone());
                    self.hub.audio.record_failure(&self.relay.slug, urls);
                    failed_rounds += 1;
                    if failed_rounds >= self.hub.cfg.station_fail_rounds {
                        // No audio for this station here. Stop spending anything
                        // on it: release its listeners (their players reconnect,
                        // and HAProxy tries them on another server) and refuse it
                        // for a while. Other stations on this engine are untouched.
                        tracing::error!(station = %slug, reason = %self.last_error, retry_in = ?self.hub.cfg.station_retry, "no audio for this station: releasing its listeners and resources");
                        self.hub.mark_silent(&self.station, self.last_error.clone());
                        break 'relay;
                    }
                    self.relay.source.store(Source::None as u8, Ordering::Relaxed);
                    self.relay.status.send_replace(Status::Failed);
                    first = Source::Primary;
                    let until = Instant::now() + backoff;
                    backoff = (backoff * 2).min(Duration::from_secs(15));
                    while Instant::now() < until {
                        sleep(Duration::from_secs(1)).await;
                        match self.housekeep().await {
                            Some(Flow::Stop) => break 'relay,
                            Some(_) => break,
                            None => {}
                        }
                    }
                    self.relay.status.send_replace(Status::Connecting);
                }
            }
        }

        self.hub.remove(&self.relay);
        self.relay.close();
        stats::retire(&self.hub, &self.relay).await;
        tracing::info!(station = %slug, "relay stopped");
    }

    fn url_of(&self, source: Source) -> Option<&str> {
        match source {
            Source::Primary => Some(self.station.primary.as_str()),
            Source::Backup => self.station.backup.as_deref(),
            Source::None => None,
        }
    }

    async fn connect_any(&mut self, first: Source) -> Option<(Upstream, Source)> {
        let second = if first == Source::Primary { Source::Backup } else { Source::Primary };
        let mut errors = Vec::new();
        for source in [first, second] {
            let Some(url) = self.url_of(source) else { continue };
            match self.hub.connector.connect(url).await {
                Ok(upstream) => return Some((upstream, source)),
                Err(error) => {
                    tracing::warn!(station = %self.relay.slug, source = source.as_str(), %error, "source unavailable");
                    errors.push(format!("{}: {error}", source.as_str()));
                }
            }
        }
        errors.sort();
        self.last_error = errors.join("; ");
        None
    }

    /// Per-second upkeep: idle shutdown and picking up profile changes.
    async fn housekeep(&mut self) -> Option<Flow> {
        // A server with no audio lets its listeners go, so their players
        // reconnect and are placed on a server that has it.
        if self.hub.audio.is_no_audio() {
            tracing::info!(station = %self.relay.slug, "server has no audio, releasing listeners");
            return Some(Flow::Stop);
        }
        if self.relay.connections() == 0 {
            let since = *self.idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= self.hub.cfg.idle_grace && self.hub.remove_if_idle(&self.relay) {
                return Some(Flow::Stop);
            }
        } else {
            self.idle_since = None;
        }

        if self.last_refresh.elapsed() >= self.hub.cfg.config_refresh {
            self.last_refresh = Instant::now();
            let mut redis = self.hub.redis.clone();
            match Station::load(&mut redis, &self.relay.slug).await {
                Ok(Some(fresh)) if fresh.active => {
                    let rewired = fresh.primary != self.station.primary || fresh.backup != self.station.backup;
                    self.station = fresh;
                    if rewired {
                        tracing::info!(station = %self.relay.slug, "source URLs changed, reconnecting");
                        return Some(Flow::Reconfigured);
                    }
                }
                Ok(_) => {
                    tracing::info!(station = %self.relay.slug, "station suspended or removed, disconnecting listeners");
                    return Some(Flow::Stop);
                }
                // Redis being briefly unavailable must not interrupt audio.
                Err(error) => tracing::warn!(%error, "station profile refresh failed"),
            }
        }
        None
    }

    fn poll_metadata(&mut self) {
        let Some(url) = self.station.metadata_url.clone() else { return };
        if self.last_meta_poll.is_some_and(|at| at.elapsed() < self.hub.cfg.metadata_poll) {
            return;
        }
        self.last_meta_poll = Some(Instant::now());
        let hub = self.hub.clone();
        let relay = self.relay.clone();
        let fallback_art = self.station.artwork_url.clone().unwrap_or_default();
        tokio::spawn(async move {
            match hub.connector.fetch_text(&url).await {
                Ok(text) => {
                    if let Some(found) = nowplaying::parse(&text, &url) {
                        let artwork = if found.artwork.is_empty() { fallback_art } else { found.artwork };
                        relay.external_meta_at.store(unix_now(), Ordering::Relaxed);
                        relay.set_title(found.title, found.artist, artwork);
                    }
                }
                Err(error) => tracing::debug!(station = %relay.slug, %error, "metadata URL poll failed"),
            }
        });
    }

    /// In-stream titles are used unless the metadata URL is answering.
    fn accept_stream_title(&self, title: String) {
        let fresh_for = self.hub.cfg.metadata_poll.as_secs() * 3;
        let external_ok = self.station.metadata_url.is_some()
            && unix_now().saturating_sub(self.relay.external_meta_at.load(Ordering::Relaxed)) <= fresh_for;
        if !external_ok {
            let artwork = self.station.artwork_url.clone().unwrap_or_default();
            self.relay.set_title(title, String::new(), artwork);
        }
    }

    async fn pump(&mut self, mut upstream: Upstream, mut source: Source) -> Flow {
        let cfg = self.hub.cfg.clone();
        let mut demux = upstream.metaint.map(IcyDemux::new);
        self.relay.clear_burst();
        self.relay.set_live(std::mem::take(&mut upstream.info), source);
        tracing::info!(station = %self.relay.slug, source = source.as_str(), "source connected");

        let mut tick = interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut last_data = Instant::now();
        let mut probe: Option<JoinHandle<Result<Upstream, String>>> = None;
        let mut next_probe = Instant::now() + cfg.primary_retry;
        let mut audio = Vec::new();

        let flow = loop {
            tokio::select! {
                item = upstream.body.next() => match item {
                    Some(Ok(chunk)) => {
                        last_data = Instant::now();
                        self.relay.last_audio.store(unix_now(), Ordering::Relaxed);
                        match demux.as_mut() {
                            Some(demux) => {
                                if let Some(title) = demux.feed(chunk, &mut audio) {
                                    self.accept_stream_title(title);
                                }
                                for piece in audio.drain(..) {
                                    self.relay.publish(piece, cfg.burst_bytes);
                                }
                            }
                            None if chunk.is_empty() => {}
                            None => self.relay.publish(chunk, cfg.burst_bytes),
                        }
                    }
                    Some(Err(error)) => {
                        tracing::warn!(station = %self.relay.slug, source = source.as_str(), %error, "source read failed");
                        break Flow::SourceLost(source);
                    }
                    None => {
                        tracing::warn!(station = %self.relay.slug, source = source.as_str(), "source closed the stream");
                        break Flow::SourceLost(source);
                    }
                },

                _ = tick.tick() => {
                    if last_data.elapsed() >= cfg.stall_timeout {
                        tracing::warn!(station = %self.relay.slug, source = source.as_str(), "source stalled");
                        break Flow::SourceLost(source);
                    }
                    if let Some(flow) = self.housekeep().await {
                        break flow;
                    }
                    self.poll_metadata();
                    if source == Source::Backup && probe.is_none() && Instant::now() >= next_probe {
                        let connector = self.hub.connector.clone();
                        let primary = self.station.primary.clone();
                        probe = Some(tokio::spawn(async move { connector.connect(&primary).await }));
                    }
                }

                result = async { probe.as_mut().unwrap().await }, if probe.is_some() => {
                    probe = None;
                    next_probe = Instant::now() + cfg.primary_retry;
                    if let Ok(Ok(mut recovered)) = result {
                        tracing::info!(station = %self.relay.slug, "primary source recovered, switching back");
                        demux = recovered.metaint.map(IcyDemux::new);
                        source = Source::Primary;
                        self.relay.set_live(std::mem::take(&mut recovered.info), source);
                        upstream = recovered;
                        last_data = Instant::now();
                    }
                }
            }
        };

        if let Some(probe) = probe {
            probe.abort();
        }
        flow
    }
}
