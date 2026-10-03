//! What a station plays, moment by moment.
//!
//! One task per station with listeners decides what goes out:
//!
//!   primary stream ──fails──▶ ident ──▶ backup stream ──fails──▶ ident ──▶ fallback file
//!        ▲                                   ▲                                  │
//!        └───────────── back as soon as a live source is healthy again ────────┘
//!
//! "Fails" means no audio for the station's failover delay (6 seconds unless
//! changed): the source is gone, sends nothing, or sends digital silence. A
//! source that drops is retried for that long before it is given up on. The
//! delay applies to leaving a source only: a source that is back is returned to
//! as soon as it has delivered a second of real audio.
//!
//! Nothing is decoded or re-encoded. Every switch happens between whole audio
//! frames, which is why idents and fallback files must be in the same format
//! as the stream; ones that are not are skipped rather than played.

use std::{
    collections::VecDeque,
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use tokio::{
    sync::mpsc,
    time::{interval, sleep, sleep_until, timeout, timeout_at, Instant, MissedTickBehavior},
};

use crate::{
    frames::{attenuate, supported, Codec, Entry, Frame, Framer},
    hub::{unix_now, Hub, Relay, Source, Status},
    icy::IcyDemux,
    nowplaying,
    station::{Media, Station},
    stats,
    upstream::{Body, StreamInfo, Upstream},
};

/// How much of a file is read ahead of what has been played.
const FILE_LEAD: Duration = Duration::from_secs(1);
/// How long a stream that was down must deliver real audio before the station
/// returns to it: long enough to know it is really back, short enough to be at once.
const RETURN_CONFIRM: Duration = Duration::from_secs(1);
/// How often a stream that is down is tried again while something else plays.
/// This much audio without one recognisable frame means the stream is not
/// what its label says. A real stream never goes a tenth as long without one.
const UNFRAMED_AFTER: usize = 16 * 1024;
const RECHECK: Duration = Duration::from_secs(2);
/// A fade lasts this many half-frames (granules), each 1.5 dB apart: about half
/// a second at 44.1 kHz, down to or up from 60 dB below full level.
const FADE_GRANULES: u32 = 40;
/// Idents are short; anything larger is not loaded.
const MAX_IDENT_BYTES: usize = 4 * 1024 * 1024;

/// A connected live source and everything needed to keep reading it.
pub struct LiveSource {
    source: Source,
    body: Body,
    info: StreamInfo,
    demux: Option<IcyDemux>,
    /// `None` when the format cannot be cut into frames; it is then relayed as raw bytes.
    framer: Option<Framer>,
    /// Frames already read while the source was being checked, to be played first.
    pending: Vec<Frame>,
    /// What has arrived since the last frame was recognised. A stream that is
    /// labelled MP3 or AAC but is not made of frames this engine knows (MPEG
    /// Layer II, say), or that changes format on the way, is relayed as it
    /// arrives from the moment that is clear, starting with this.
    held: Vec<Bytes>,
    held_bytes: usize,
}

impl LiveSource {
    fn new(upstream: Upstream, source: Source) -> Self {
        let framer = supported(&upstream.info.content_type).then(Framer::new);
        Self { source, body: upstream.body, demux: upstream.metaint.map(IcyDemux::new), info: upstream.info, framer, pending: Vec::new(), held: Vec::new(), held_bytes: 0 }
    }

    /// Reads the next piece. Frames (or raw audio, for formats that are not
    /// framed) are appended; a title is returned when the source announces one.
    async fn next(&mut self, frames: &mut Vec<Frame>, raw: &mut Vec<Bytes>) -> Result<Option<String>, String> {
        if !self.pending.is_empty() {
            frames.append(&mut self.pending);
            return Ok(None);
        }
        let chunk = match self.body.next().await {
            Some(Ok(chunk)) => chunk,
            Some(Err(error)) => return Err(error.to_string()),
            None => return Err("the source closed the stream".into()),
        };
        let mut title = None;
        let mut audio = Vec::new();
        match self.demux.as_mut() {
            Some(demux) => title = demux.feed(chunk, &mut audio),
            None => audio.push(chunk),
        }
        for piece in audio {
            match self.framer.as_mut() {
                Some(framer) => {
                    let before = frames.len();
                    framer.push(&piece, frames);
                    if frames.len() > before {
                        self.held.clear();
                        self.held_bytes = 0;
                    } else {
                        self.held_bytes += piece.len();
                        self.held.push(piece);
                        if self.held_bytes > UNFRAMED_AFTER {
                            self.framer = None;
                            raw.append(&mut self.held);
                        }
                    }
                }
                None if piece.is_empty() => {}
                None => raw.push(piece),
            }
        }
        Ok(title)
    }
}

/// Whether what just arrived counts as audio for the dead-air check.
fn has_sound(frames: &[Frame], raw: &[Bytes], detect_silence: bool) -> bool {
    !raw.is_empty() || frames.iter().any(|frame| !detect_silence || !frame.silent)
}

/// Watches a source in the background and hands it over as soon as it is
/// delivering real audio again, so the relay can cut to it without a gap.
fn watch_source(hub: Arc<Hub>, slug: String, url: String, source: Source, detect_silence: bool) -> mpsc::Receiver<LiveSource> {
    let (tx, rx) = mpsc::channel(1);
    tokio::spawn(async move {
        let hold = RETURN_CONFIRM;
        let retry = hub.cfg.primary_retry.min(RECHECK);
        loop {
            let attempt = tokio::select! {
                _ = tx.closed() => return,
                result = hub.connector.connect(&url) => result,
            };
            if let Ok(upstream) = attempt {
                let mut live = LiveSource::new(upstream, source);
                let mut good_since: Option<Instant> = None;
                let (mut frames, mut raw) = (Vec::new(), Vec::new());
                loop {
                    frames.clear();
                    raw.clear();
                    let read = tokio::select! {
                        _ = tx.closed() => return,
                        read = timeout(hold.max(Duration::from_secs(2)), live.next(&mut frames, &mut raw)) => read,
                    };
                    if !matches!(read, Ok(Ok(_))) {
                        break;
                    }
                    if frames.is_empty() && raw.is_empty() {
                        continue;
                    }
                    if has_sound(&frames, &raw, detect_silence) {
                        if good_since.get_or_insert_with(Instant::now).elapsed() >= hold {
                            // What was just read is the first thing listeners hear of it.
                            live.pending = std::mem::take(&mut frames);
                            tracing::info!(station = %slug, source = source.as_str(), "source has audio again");
                            let _ = tx.send(live).await;
                            return;
                        }
                    } else {
                        good_since = None;
                    }
                }
            }
            tokio::select! {
                _ = tx.closed() => return,
                _ = sleep(retry) => {}
            }
        }
    });
    rx
}

/// Waits, reading and discarding `incoming` meanwhile so that it stays live.
async fn pause(wait: Duration, incoming: &mut Option<&mut LiveSource>) {
    let until = Instant::now() + wait;
    let (mut frames, mut raw) = (Vec::new(), Vec::new());
    loop {
        let Some(live) = incoming.as_deref_mut() else {
            sleep_until(until).await;
            return;
        };
        match timeout_at(until, live.next(&mut frames, &mut raw)).await {
            Ok(Ok(_)) => {
                frames.clear();
                raw.clear();
            }
            // It dropped again: whoever plays it next finds out and deals with it.
            Ok(Err(_)) => *incoming = None,
            Err(_) => return,
        }
    }
}

async fn recv(watcher: &mut Option<mpsc::Receiver<LiveSource>>) -> LiveSource {
    match watcher {
        Some(rx) => match rx.recv().await {
            Some(live) => live,
            None => std::future::pending().await,
        },
        None => std::future::pending().await,
    }
}

enum Flow {
    /// The station's sources were edited.
    Reconfigured,
    /// No listeners left, or the station was suspended or deleted.
    Stop,
}

enum Outcome {
    Flow(Flow),
    /// A healthier source is ready: cut to it.
    Switch(LiveSource),
    /// The connection dropped; it may come straight back.
    Lost(Source),
    /// Connected, but no audio for the whole failover delay.
    Dead(Source, &'static str),
    /// The fallback file could not be played.
    Unavailable,
}

struct Ident {
    version: String,
    frames: Vec<Frame>,
}

pub struct RelayTask {
    hub: Arc<Hub>,
    relay: Arc<Relay>,
    station: Station,
    idle_since: Option<Instant>,
    last_refresh: Instant,
    last_meta_poll: Option<Instant>,
    /// Why the last source round failed, for the dashboard.
    last_error: String,
    primary_watch: Option<mpsc::Receiver<LiveSource>>,
    backup_watch: Option<mpsc::Receiver<LiveSource>>,
    ident: Arc<Mutex<Option<Ident>>>,
    /// Makes the first frames after each cut decodable.
    entry: Entry,
    /// A fade in progress: whether it is rising, and how many granules it has covered.
    fade: Option<(bool, u32)>,
    /// The last thing sent to listeners was silence.
    out_silent: bool,
    /// The bitrate of the stream's first frame, to notice a variable bitrate.
    first_bitrate: Option<u32>,
}

impl RelayTask {
    pub fn new(hub: Arc<Hub>, relay: Arc<Relay>, station: Station) -> Self {
        Self {
            hub,
            relay,
            station,
            idle_since: None,
            last_refresh: Instant::now(),
            last_meta_poll: None,
            last_error: String::new(),
            primary_watch: None,
            backup_watch: None,
            ident: Arc::new(Mutex::new(None)),
            entry: Entry::new(),
            fade: None,
            out_silent: true,
            first_bitrate: None,
        }
    }

    pub async fn run(mut self) {
        let slug = self.relay.slug.clone();
        tracing::info!(station = %slug, "relay starting");
        self.load_ident();
        let mut backoff = Duration::from_secs(1);
        let mut failed_rounds = 0u32;
        // The first connection is made at once: the delay and the ident are
        // for a station that goes quiet while people are listening.
        let mut current = self.connect_initial().await;

        'relay: loop {
            let outcome = match current.take() {
                Some(live) => {
                    self.hub.audio.record_success();
                    self.hub.clear_silent(&slug);
                    failed_rounds = 0;
                    backoff = Duration::from_secs(1);
                    self.play_live(live).await
                }
                None if self.station.fallback.is_some() => self.play_fallback().await,
                None => Outcome::Unavailable,
            };

            match outcome {
                Outcome::Flow(Flow::Stop) => break,
                Outcome::Flow(Flow::Reconfigured) => {
                    self.primary_watch = None;
                    self.backup_watch = None;
                    current = self.connect_initial().await;
                }
                Outcome::Switch(mut live) => {
                    // A stream is back. With an ident, the ident announces the return;
                    // without one, what was playing has already been faded out.
                    self.play_ident(Some(&mut live)).await;
                    current = Some(live);
                }
                Outcome::Lost(source) => {
                    // Listeners hear nothing while it is retried; their players' buffers cover part of it.
                    let deadline = Instant::now() + self.station.failover_delay;
                    match self.reconnect_until(source, deadline).await {
                        Ok(Some(live)) => current = Some(live),
                        Ok(None) => match self.fail_over(source).await {
                            Ok(next) => current = next,
                            Err(Flow::Stop) => break,
                            Err(Flow::Reconfigured) => current = self.connect_initial().await,
                        },
                        Err(Flow::Stop) => break,
                        Err(Flow::Reconfigured) => current = self.connect_initial().await,
                    }
                }
                Outcome::Dead(source, why) => {
                    tracing::warn!(station = %slug, source = source.as_str(), reason = why, delay = ?self.station.failover_delay, "no audio from the source for the failover delay");
                    match self.fail_over(source).await {
                        Ok(next) => current = next,
                        Err(Flow::Stop) => break,
                        Err(Flow::Reconfigured) => current = self.connect_initial().await,
                    }
                }
                Outcome::Unavailable => {
                    // Nothing at all to play here: neither source, and no usable file.
                    let mut urls = vec![self.station.primary.clone()];
                    urls.extend(self.station.backup.clone());
                    self.hub.audio.record_failure(&slug, urls);
                    failed_rounds += 1;
                    if failed_rounds >= self.hub.cfg.station_fail_rounds {
                        // Stop spending anything on it: release its listeners (their
                        // players reconnect, and HAProxy tries them on another server)
                        // and refuse it for a while. Other stations are untouched.
                        tracing::error!(station = %slug, reason = %self.last_error, retry_in = ?self.hub.cfg.station_retry, "no audio for this station: releasing its listeners and resources");
                        self.hub.mark_silent(&self.station, self.last_error.clone());
                        break 'relay;
                    }
                    self.relay.set_source(Source::None);
                    self.relay.set_status(Status::Failed);
                    let until = Instant::now() + backoff;
                    backoff = (backoff * 2).min(Duration::from_secs(15));
                    while Instant::now() < until {
                        sleep(Duration::from_secs(1)).await;
                        match self.housekeep().await {
                            Some(Flow::Stop) => break 'relay,
                            Some(Flow::Reconfigured) => break,
                            None => {}
                        }
                    }
                    self.relay.set_status(Status::Connecting);
                    current = self.connect_initial().await;
                }
            }
        }

        self.hub.remove(&self.relay);
        self.relay.close();
        stats::retire(&self.hub, &self.relay).await;
        tracing::info!(station = %slug, "relay stopped");
    }

    fn url_of(&self, source: Source) -> Option<String> {
        match source {
            Source::Primary => Some(self.station.primary.clone()),
            Source::Backup => self.station.backup.clone(),
            _ => None,
        }
    }

    /// Primary, then backup, without waiting: used when the station starts.
    async fn connect_initial(&mut self) -> Option<LiveSource> {
        let mut errors = Vec::new();
        for source in [Source::Primary, Source::Backup] {
            let Some(url) = self.url_of(source) else { continue };
            match self.hub.connector.connect(&url).await {
                Ok(upstream) => return Some(LiveSource::new(upstream, source)),
                Err(error) => {
                    tracing::warn!(station = %self.relay.slug, source = source.as_str(), %error, "source unavailable");
                    errors.push(format!("{}: {error}", source.as_str()));
                }
            }
        }
        self.last_error = errors.join("; ");
        None
    }

    /// Keeps trying one source until the deadline.
    async fn reconnect_until(&mut self, source: Source, deadline: Instant) -> Result<Option<LiveSource>, Flow> {
        let Some(url) = self.url_of(source) else { return Ok(None) };
        self.relay.set_status(Status::Connecting);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            match timeout(left, self.hub.connector.connect(&url)).await {
                Ok(Ok(upstream)) => {
                    tracing::info!(station = %self.relay.slug, source = source.as_str(), "source reconnected within the failover delay");
                    return Ok(Some(LiveSource::new(upstream, source)));
                }
                Ok(Err(error)) => self.last_error = format!("{}: {error}", source.as_str()),
                Err(_) => return Ok(None),
            }
            sleep(Duration::from_millis(750).min(deadline.saturating_duration_since(Instant::now()))).await;
            if let Some(flow) = self.housekeep().await {
                return Err(flow);
            }
        }
    }

    /// The source in use has failed for good (for now). Plays the ident and
    /// moves down one step: to the backup stream if there is one that works,
    /// otherwise to the fallback file. `Ok(None)` means "play the fallback".
    async fn fail_over(&mut self, from: Source) -> Result<Option<LiveSource>, Flow> {
        self.play_ident(None).await;
        if from == Source::Primary && self.station.backup.is_some() {
            let deadline = Instant::now() + self.station.failover_delay;
            if let Some(live) = self.reconnect_until(Source::Backup, deadline).await? {
                tracing::info!(station = %self.relay.slug, "switched to the backup stream");
                return Ok(Some(live));
            }
            tracing::warn!(station = %self.relay.slug, reason = %self.last_error, "backup stream unavailable too");
            self.play_ident(None).await;
        }
        Ok(None)
    }

    /// Starts or stops the background watchers according to what is playing.
    fn watch(&mut self, playing: Source) {
        let detect = self.station.silence_detection;
        if playing == Source::Primary {
            self.primary_watch = None;
            self.backup_watch = None;
            return;
        }
        if self.primary_watch.is_none() {
            self.primary_watch = Some(watch_source(self.hub.clone(), self.relay.slug.clone(), self.station.primary.clone(), Source::Primary, detect));
        }
        if playing == Source::Backup {
            self.backup_watch = None;
        } else if self.backup_watch.is_none() {
            if let Some(url) = self.station.backup.clone() {
                self.backup_watch = Some(watch_source(self.hub.clone(), self.relay.slug.clone(), url, Source::Backup, detect));
            }
        }
    }

    fn publish_frames(&mut self, frames: &[Frame]) {
        if frames.is_empty() {
            return;
        }
        let mut out = BytesMut::with_capacity(frames.iter().map(|f| f.data.len()).sum());
        for frame in frames {
            // Just after a cut, frames that need audio from before it are sent as silence.
            if let Some(silenced) = self.entry.admit(frame) {
                out.extend_from_slice(&silenced);
                continue;
            }
            let faded = self.fade.and_then(|(rising, covered)| {
                // MPEG-1 frames hold two granules, MPEG-2 and 2.5 frames one.
                let granules = if frame.data.len() >= 2 && (frame.data[1] >> 3) & 3 == 3 { 2 } else { 1 };
                let level = |granule: u32| {
                    let at = (covered + granule).min(FADE_GRANULES);
                    (if rising { FADE_GRANULES - at } else { at + 1 }).min(FADE_GRANULES) as u8
                };
                let covered = covered + granules;
                // A fade out holds its lowest level until the cut; a fade in ends at full level.
                self.fade = (!rising || covered < FADE_GRANULES).then_some((rising, covered));
                attenuate(frame, [level(0), level(1)])
            });
            match faded {
                Some(faded) => out.extend_from_slice(&faded),
                None => out.extend_from_slice(&frame.data),
            }
        }
        self.out_silent = frames.last().is_some_and(|frame| frame.silent);
        self.relay.publish(out.freeze(), self.hub.cfg.burst_bytes);
    }

    /// Records the stream's format the first time it is seen, for checking
    /// uploaded idents and fallback files against it.
    fn learn_format(&mut self, frame: &Frame, info: &StreamInfo) {
        if frame.bitrate_kbps > 0 && self.first_bitrate.is_some_and(|first| first != 0 && first != frame.bitrate_kbps) {
            // Frames of different bitrates: the stream has no single bitrate to match.
            self.first_bitrate = Some(0);
            self.describe_stream(vec![("bitrate", "0".into()), ("vbr", "1".into())], false);
        }
        let reframed = self.relay.set_unframed(false);
        if !self.relay.set_format(frame.format) && !reframed {
            return;
        }
        self.first_bitrate = Some(frame.bitrate_kbps);
        let bitrate = if frame.bitrate_kbps > 0 { frame.bitrate_kbps } else { info.header("icy-br").and_then(|v| v.parse().ok()).unwrap_or(0) };
        // AAC+ halves the sample rate in its frame headers and is announced as "aacp".
        let he_aac = frame.format.codec == Codec::Aac && (frame.format.sample_rate <= 24000 || info.content_type.to_ascii_lowercase().contains("aacp"));
        self.describe_stream(
            vec![
                ("framed", "1".into()),
                ("codec", frame.format.codec.as_str().to_string()),
                ("profile", if he_aac { "he-aac".into() } else { frame.format.codec.as_str().to_string() }),
                ("sample_rate", frame.format.sample_rate.to_string()),
                ("channels", frame.format.channels.to_string()),
                ("bitrate", bitrate.to_string()),
                ("content_type", info.content_type.clone()),
                ("seen_at", unix_now().to_string()),
            ],
            true,
        );
    }

    /// Records that the stream is being relayed as it arrives, with none of
    /// the features that need its frames.
    fn learn_unframed(&mut self, info: &StreamInfo) {
        if !self.relay.set_unframed(true) {
            return;
        }
        self.first_bitrate = None;
        if supported(&info.content_type) {
            tracing::warn!(station = %self.relay.slug, content_type = %info.content_type, "the stream is not made of MP3 or AAC (ADTS) frames: relaying it as it is, without silence detection, idents or fallback audio");
        }
        self.describe_stream(
            vec![("framed", "0".into()), ("content_type", info.content_type.clone()), ("seen_at", unix_now().to_string())],
            true,
        );
    }

    /// Publishes what the stream is (format:<slug>), for the dashboard and for checking uploads.
    fn describe_stream(&self, fields: Vec<(&'static str, String)>, replace: bool) {
        let key = format!("format:{}", self.relay.slug);
        let mut redis = self.hub.redis.clone();
        tokio::spawn(async move {
            let mut pipe = redis::pipe();
            pipe.atomic();
            if replace {
                pipe.del(&key);
            }
            pipe.hset_multiple(&key, &fields);
            let _: redis::RedisResult<()> = pipe.query_async(&mut redis).await;
        });
    }

    /// Whether moving to a stream that is back should be a fade: only when
    /// there is no ident to mark the change, something audible is playing, and
    /// the format lets the level be changed without decoding.
    fn fades(&self) -> bool {
        !self.ident_ready() && !self.out_silent && self.relay.format().is_some_and(|format| format.codec == Codec::Mp3)
    }

    fn ident_ready(&self) -> bool {
        let wanted = self.relay.format();
        !self.relay.unframed() && self.ident.lock().unwrap().as_ref().is_some_and(|ident| wanted.is_none_or(|format| ident.frames[0].format == format))
    }

    async fn play_live(&mut self, mut live: LiveSource) -> Outcome {
        self.entry = Entry::new();
        let source = live.source;
        let delay = self.station.failover_delay;
        self.watch(source);
        self.relay.set_live(std::mem::take(&mut live.info), source);
        tracing::info!(station = %self.relay.slug, source = source.as_str(), "playing the live stream");

        let mut tick = interval(Duration::from_millis(250));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut ticks = 0u32;
        let mut last_sound = Instant::now();
        let mut last_data = Instant::now();
        let (mut frames, mut raw) = (Vec::new(), Vec::new());
        let info = self.relay.current_info();

        loop {
            tokio::select! {
                read = live.next(&mut frames, &mut raw) => match read {
                    Ok(title) => {
                        if let Some(title) = title {
                            self.accept_stream_title(title);
                        }
                        if !frames.is_empty() || !raw.is_empty() {
                            last_data = Instant::now();
                            if has_sound(&frames, &raw, self.station.silence_detection) {
                                last_sound = last_data;
                                self.relay.touch_audio();
                            }
                            if let Some(info) = info.as_ref() {
                                match frames.first() {
                                    Some(frame) => self.learn_format(frame, info),
                                    None if live.framer.is_none() => self.learn_unframed(info),
                                    None => {}
                                }
                            }
                            // Silence is still sent on: it is what the source is broadcasting.
                            self.publish_frames(&frames);
                            for piece in raw.drain(..) {
                                self.relay.publish(piece, self.hub.cfg.burst_bytes);
                            }
                            frames.clear();
                        }
                    }
                    Err(error) => {
                        tracing::warn!(station = %self.relay.slug, source = source.as_str(), %error, "live stream lost");
                        self.last_error = format!("{}: {error}", source.as_str());
                        return Outcome::Lost(source);
                    }
                },

                _ = tick.tick() => {
                    if last_sound.elapsed() >= delay {
                        let why = if last_data.elapsed() >= delay { "the source stopped sending" } else { "the source is sending silence" };
                        self.last_error = format!("{}: {why}", source.as_str());
                        return Outcome::Dead(source, why);
                    }
                    ticks += 1;
                    if ticks % 4 == 0 {
                        if let Some(flow) = self.housekeep().await {
                            return Outcome::Flow(flow);
                        }
                        self.poll_metadata();
                    }
                }

                better = recv(&mut self.primary_watch), if source != Source::Primary => {
                    tracing::info!(station = %self.relay.slug, "primary stream is back: returning to it");
                    if self.fades() {
                        // Fade this stream out over its next half second, then bring the primary in.
                        self.fade = Some((false, 0));
                        let until = Instant::now() + Duration::from_millis(900);
                        while self.fade.is_some_and(|(_, covered)| covered < FADE_GRANULES) {
                            frames.clear();
                            raw.clear();
                            match timeout_at(until, live.next(&mut frames, &mut raw)).await {
                                Ok(Ok(_)) => self.publish_frames(&frames),
                                _ => break,
                            }
                        }
                        self.fade = Some((true, 0));
                    }
                    return Outcome::Switch(better);
                }
            }
        }
    }

    // ── Ident ───────────────────────────────────────────────────────────────

    fn media_request(&self, media: &Media) -> Option<reqwest::RequestBuilder> {
        let base = self.hub.files_base.as_deref()?;
        let mut request = self.hub.internal.get(format!("{}/api/v1/internal/files/{}", base.trim_end_matches('/'), media.id));
        if let Some(secret) = self.hub.engine_secret.as_deref() {
            request = request.header("X-Engine-Auth", secret);
        }
        Some(request)
    }

    /// Fetches the station's ident in the background so it is in memory when needed.
    fn load_ident(&self) {
        let Some(media) = self.station.ident.clone() else {
            *self.ident.lock().unwrap() = None;
            return;
        };
        if self.ident.lock().unwrap().as_ref().is_some_and(|loaded| loaded.version == media.version) {
            return;
        }
        let Some(request) = self.media_request(&media) else { return };
        let slot = self.ident.clone();
        let slug = self.relay.slug.clone();
        tokio::spawn(async move {
            let fetched = async {
                let response = request.timeout(Duration::from_secs(20)).send().await.map_err(|e| e.to_string())?;
                if !response.status().is_success() {
                    return Err(format!("HTTP {}", response.status().as_u16()));
                }
                let body = response.bytes().await.map_err(|e| e.to_string())?;
                if body.len() > MAX_IDENT_BYTES {
                    return Err("the ident is too large".into());
                }
                let mut frames = Vec::new();
                Framer::new().push(&body, &mut frames);
                if frames.is_empty() { Err("it contains no MP3 or AAC audio".to_string()) } else { Ok(frames) }
            }
            .await;
            match fetched {
                Ok(frames) => *slot.lock().unwrap() = Some(Ident { version: media.version, frames }),
                Err(error) => tracing::warn!(station = %slug, ident = %media.name, %error, "the ident could not be loaded and will not be played"),
            }
        });
    }

    /// Plays the ident, in real time, if there is one in the stream's format.
    ///
    /// When it introduces a stream that is back, that stream is passed in and
    /// kept reading meanwhile, so that it is heard live when the ident ends
    /// rather than from where it was when the ident began.
    async fn play_ident(&mut self, mut incoming: Option<&mut LiveSource>) {
        let frames = match self.ident.lock().unwrap().as_ref() {
            Some(ident) => ident.frames.clone(),
            None => return,
        };
        if self.relay.unframed() {
            // Nothing can be spliced into a stream that is not cut into frames.
            return;
        }
        if let Some(format) = self.relay.format() {
            if frames[0].format != format {
                tracing::warn!(station = %self.relay.slug, stream = %format, ident = %frames[0].format, "ident skipped: its format differs from the stream's");
                return;
            }
        }
        tracing::info!(station = %self.relay.slug, "playing the ident");
        self.entry = Entry::new();
        self.fade = None;
        let started = Instant::now();
        let mut sent = Duration::ZERO;
        for batch in frames.chunks(4) {
            self.publish_frames(batch);
            sent += Duration::from_micros(batch.iter().map(|f| f.duration_us).sum());
            // Stay a little ahead of real time so players do not underrun.
            if let Some(wait) = sent.checked_sub(started.elapsed() + Duration::from_millis(200)) {
                pause(wait, &mut incoming).await;
            }
        }
        if let Some(wait) = sent.checked_sub(started.elapsed()) {
            pause(wait, &mut incoming).await;
        }
    }

    // ── Fallback file ───────────────────────────────────────────────────────

    /// Loops the station's fallback file until a live source is healthy again.
    async fn play_fallback(&mut self) -> Outcome {
        let Some(media) = self.station.fallback.clone() else { return Outcome::Unavailable };
        if self.relay.unframed() {
            self.last_error = "the fallback file cannot follow a stream that is neither MP3 nor AAC".into();
            return Outcome::Unavailable;
        }
        self.watch(Source::Fallback);
        let wanted = self.relay.format();
        let mut body: Option<Body> = None;
        let mut framer = Framer::new();
        let mut queue: VecDeque<Frame> = VecDeque::new();
        let mut queued = Duration::ZERO;
        let mut announced = false;
        let mut failures = 0u32;
        let mut frames_this_pass = 0u64;
        let started = Instant::now();
        let mut sent = Duration::ZERO;
        let mut tick = interval(Duration::from_millis(100));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut ticks = 0u32;
        let mut incoming = Vec::new();

        loop {
            if body.is_none() {
                let Some(request) = self.media_request(&media) else {
                    self.last_error = "fallback file: this server does not know where to fetch files from".into();
                    return Outcome::Unavailable;
                };
                match request.send().await {
                    Ok(response) if response.status().is_success() => {
                        body = Some(response.bytes_stream().map(|r| r.map_err(std::io::Error::other)).boxed());
                        frames_this_pass = 0;
                        self.entry = Entry::new();
                    }
                    other => {
                        failures += 1;
                        let why = match other {
                            Ok(response) => format!("HTTP {}", response.status().as_u16()),
                            Err(error) => error.to_string(),
                        };
                        tracing::warn!(station = %self.relay.slug, file = %media.name, error = %why, "fallback file could not be opened");
                        if failures >= 3 {
                            self.last_error = format!("fallback file: {why}");
                            return Outcome::Unavailable;
                        }
                        sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                }
            }

            tokio::select! {
                // Read only a little ahead of what has been played.
                chunk = async { body.as_mut().unwrap().next().await }, if queued < FILE_LEAD => match chunk {
                    Some(Ok(chunk)) => {
                        framer.push(&chunk, &mut incoming);
                        for frame in incoming.drain(..) {
                            if wanted.is_some_and(|format| format != frame.format) {
                                tracing::error!(station = %self.relay.slug, file = %media.name, stream = %wanted.unwrap(), file_format = %frame.format, "fallback file skipped: its format differs from the stream's");
                                self.last_error = format!("fallback file is {}, but the stream is {}", frame.format, wanted.unwrap());
                                return Outcome::Unavailable;
                            }
                            queued += Duration::from_micros(frame.duration_us);
                            queue.push_back(frame);
                            frames_this_pass += 1;
                            failures = 0;
                        }
                    }
                    Some(Err(_)) | None => {
                        // End of the file (or the connection): start it again.
                        if frames_this_pass == 0 {
                            failures += 1;
                            if failures >= 3 {
                                self.last_error = "fallback file contains no playable MP3 or AAC audio".into();
                                return Outcome::Unavailable;
                            }
                        }
                        body = None;
                    }
                },

                _ = tick.tick() => {
                    // Send what is due, staying slightly ahead of real time.
                    let due = started.elapsed() + Duration::from_millis(300);
                    let mut batch = Vec::new();
                    while sent < due {
                        let Some(frame) = queue.pop_front() else { break };
                        let length = Duration::from_micros(frame.duration_us);
                        sent += length;
                        queued = queued.saturating_sub(length);
                        batch.push(frame);
                    }
                    if !batch.is_empty() {
                        if !announced {
                            announced = true;
                            let format = batch[0].format;
                            self.relay.set_format(format);
                            let info = self.relay.current_info().map(|info| StreamInfo { content_type: info.content_type.clone(), headers: info.headers.clone() })
                                .unwrap_or(StreamInfo { content_type: format.codec.content_type().to_string(), headers: Vec::new() });
                            self.relay.set_live(info, Source::Fallback);
                            self.relay.set_title(media.name.clone(), String::new(), self.station.artwork_url.clone().unwrap_or_default());
                            tracing::info!(station = %self.relay.slug, file = %media.name, "playing the fallback file");
                        }
                        self.publish_frames(&batch);
                    }
                    ticks += 1;
                    if ticks % 10 == 0 {
                        if let Some(flow) = self.housekeep().await {
                            return Outcome::Flow(flow);
                        }
                        if self.station.fallback.as_ref() != Some(&media) {
                            return Outcome::Flow(Flow::Reconfigured);
                        }
                    }
                }

                better = async {
                    tokio::select! {
                        biased;
                        better = recv(&mut self.primary_watch) => better,
                        better = recv(&mut self.backup_watch) => better,
                    }
                } => {
                    tracing::info!(station = %self.relay.slug, source = better.source.as_str(), "a live stream is back: leaving the fallback file");
                    if self.fades() {
                        // Fade the file out over its next half second, then bring the stream in.
                        let tail: Vec<Frame> = queue.drain(..queue.len().min(FADE_GRANULES as usize / 2)).collect();
                        self.fade = Some((false, 0));
                        self.publish_frames(&tail);
                        self.fade = Some((true, 0));
                    }
                    return Outcome::Switch(better);
                }
            }
        }
    }

    // ── Upkeep ──────────────────────────────────────────────────────────────

    /// Idle shutdown and picking up profile changes.
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
                    self.load_ident();
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
}
