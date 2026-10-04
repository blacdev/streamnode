//! Pushes relay counters to Redis.
//!
//! Accumulators, drained once a minute by the admin service:
//!   stats:bytes        hash  slug -> bytes sent to listeners
//!   stats:sessions     hash  slug -> listener connections started
//!   stats:listener_ms  hash  slug -> listener-milliseconds (for averages)
//!   stats:peak:{node}  zset  slug -> highest concurrent listener count on this engine
//!
//! Live state, refreshed every flush and expiring on its own if the engine dies:
//!   live:{slug}:{node} hash  listeners, source, title, artist, artwork, ...
//!   conns:{slug}       hash  node -> open connections (for cross-engine listener limits)
//!   silent:{node}      hash  slug -> "since|reason" for stations with no audio on this engine
//!   engine:nodes       zset  node -> unix time of its last flush (heartbeat)
//!   node:{node}        hash  CPU, memory, disk, traffic, listener totals and audio state of this engine
//!
//! Read from the master:
//!   node:{node}:audio_override  string  reason, while an administrator forces "no audio"
//!
//! Several engines may share one Redis: the counters add up, and the per-node
//! keys are combined by the admin service.

use std::{sync::Arc, time::Duration};

use redis::Pipeline;
use tokio::time::{interval, Instant, MissedTickBehavior};

use crate::{
    health::Evidence,
    hub::{unix_now, Hub, Relay, Source},
    sysinfo::Sampler,
};

const LIVE_TTL_SECS: i64 = 15;
/// How much later than this engine's first failure a peer must have received
/// audio for that to count as proof; covers clock differences between servers.
const PROOF_MARGIN_SECS: u64 = 3;

struct Taken {
    relay: Arc<Relay>,
    bytes: u64,
    sessions: u64,
    peak: usize,
}

fn stage(pipe: &mut Pipeline, node: &str, relay: &Arc<Relay>, elapsed: Duration) -> Taken {
    let (bytes, sessions, peak) = relay.take_counters();
    let slug = relay.slug.as_str();
    let listeners = relay.listeners();

    if bytes > 0 {
        pipe.hincr("stats:bytes", slug, bytes).ignore();
    }
    if sessions > 0 {
        pipe.hincr("stats:sessions", slug, sessions).ignore();
    }
    if listeners > 0 {
        let listener_ms = listeners as u64 * elapsed.as_millis() as u64;
        pipe.hincr("stats:listener_ms", slug, listener_ms).ignore();
    }
    if peak > 0 {
        pipe.cmd("ZADD").arg(format!("stats:peak:{node}")).arg("GT").arg(peak).arg(slug).ignore();
    }

    let info = relay.current_info();
    let now_playing = relay.now_playing().borrow().clone();
    let header = |name: &str| info.as_ref().and_then(|i| i.header(name)).unwrap_or_default().to_string();
    let key = format!("live:{slug}:{node}");
    pipe.hset_multiple(
        &key,
        &[
            ("listeners", listeners.to_string()),
            ("source", relay.source().as_str().to_string()),
            ("title", now_playing.title.clone()),
            ("artist", now_playing.artist.clone()),
            ("artwork", now_playing.artwork.clone()),
            ("content_type", info.as_ref().map(|i| i.content_type.clone()).unwrap_or_default()),
            ("bitrate", header("icy-br")),
            ("started_at", relay.started_at.to_string()),
            ("audio_at", relay.last_audio().to_string()),
        ],
    )
    .ignore();
    pipe.expire(&key, LIVE_TTL_SECS).ignore();
    let conns = format!("conns:{slug}");
    pipe.hset(&conns, node, relay.connections()).ignore();
    pipe.expire(&conns, LIVE_TTL_SECS).ignore();

    Taken { relay: relay.clone(), bytes, sessions, peak }
}

async fn flush(hub: &Arc<Hub>, relays: Vec<Arc<Relay>>, elapsed: Duration) {
    if relays.is_empty() {
        return;
    }
    let mut pipe = redis::pipe();
    let node = hub.cfg.node_id.as_str();
    let taken: Vec<Taken> = relays.iter().map(|relay| stage(&mut pipe, node, relay, elapsed)).collect();
    let mut redis = hub.redis.clone();
    if let Err(error) = pipe.query_async::<()>(&mut redis).await {
        tracing::warn!(%error, "stats flush failed, counters kept for the next attempt");
        for t in taken {
            t.relay.restore_counters(t.bytes, t.sessions, t.peak);
        }
    }
}

pub async fn flush_all(hub: &Arc<Hub>, elapsed: Duration) {
    flush(hub, hub.snapshot(), elapsed).await;
}

/// Final flush for a relay that has just shut down.
pub async fn retire(hub: &Arc<Hub>, relay: &Arc<Relay>) {
    flush(hub, vec![relay.clone()], Duration::ZERO).await;
    let mut redis = hub.redis.clone();
    let _ = redis::pipe()
        .del(format!("live:{}:{}", relay.slug, hub.cfg.node_id))
        .hdel(format!("conns:{}", relay.slug), &hub.cfg.node_id)
        .query_async::<()>(&mut redis)
        .await;
}

/// Gathers what the audio-health decision needs from Redis: how the other
/// engines are doing, whether one of them is playing a station this engine
/// cannot connect to, and any state an administrator has forced.
async fn audio_evidence(hub: &Arc<Hub>, live_relays: usize) -> Evidence {
    let peers = hub.peers();
    let failing = hub.audio.failing(5);
    let mut pipe = redis::pipe();
    pipe.get(format!("node:{}:audio_override", hub.cfg.node_id));
    for peer in &peers {
        pipe.hget(format!("node:{peer}"), "audio");
    }
    for peer in &peers {
        pipe.hget(format!("node:{peer}"), "audio_failing");
    }
    for (slug, _, _) in &failing {
        for peer in &peers {
            pipe.hget(format!("live:{slug}:{peer}"), "audio_at");
        }
    }
    let mut redis = hub.redis.clone();
    let answers: Vec<Option<String>> = pipe.query_async(&mut redis).await.unwrap_or_default();
    let mut answers = answers.into_iter();
    let forced = answers.next().flatten().filter(|reason| !reason.is_empty());
    let healthy_peers = answers.by_ref().take(peers.len()).filter(|a| a.as_deref() == Some("ok")).count();
    let failing_elsewhere: Vec<String> = answers
        .by_ref()
        .take(peers.len())
        .flatten()
        .flat_map(|list| list.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect::<Vec<_>>())
        .collect();
    // Proof that the fault is here: another engine received audio for the
    // same station well after this one started failing. (A source that dies
    // for everyone stops both at the same moment, which proves nothing.)
    let mut peer_plays_failed_station = false;
    for (_, _, failing_since) in &failing {
        for _ in &peers {
            let peer_audio_at = answers.next().flatten().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            if peer_audio_at >= failing_since + PROOF_MARGIN_SECS {
                peer_plays_failed_station = true;
            }
        }
    }
    Evidence { live_relays, healthy_peers, peer_plays_failed_station, failing_elsewhere, forced }
}

/// Re-tests the sources that failed. One success is enough to return to service.
fn probe_sources(hub: &Arc<Hub>) {
    let hub = hub.clone();
    tokio::spawn(async move {
        for (slug, urls, _) in hub.audio.failing(3) {
            let mut worked = false;
            for url in &urls {
                if hub.connector.connect(url).await.is_ok() {
                    worked = true;
                    break;
                }
            }
            if worked {
                tracing::info!(station = %slug, "source reachable again");
                hub.audio.record_success();
                return;
            }
            hub.audio.record_failure(&slug, urls);
        }
    });
}

/// Writes the version the master runs into the control directory, where the
/// host's updater picks it up. Only when it changes, and atomically.
async fn note_master_version(hub: &Arc<Hub>) {
    static LAST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
    let Some(dir) = hub.cfg.control_dir.as_deref() else { return };
    let mut redis = hub.redis.clone();
    let version: Option<String> = redis::cmd("HGET").arg("cluster:update").arg("master_sha").query_async(&mut redis).await.unwrap_or(None);
    let Some(version) = version.filter(|v| v.len() == 40 && v.bytes().all(|b| b.is_ascii_hexdigit())) else { return };
    if *LAST.lock().unwrap() == version {
        return;
    }
    let target = std::path::Path::new(dir).join("master-version");
    let tmp = std::path::Path::new(dir).join(".master-version.tmp");
    match std::fs::write(&tmp, format!("{version}\n")).and_then(|_| std::fs::rename(&tmp, &target)) {
        Ok(()) => *LAST.lock().unwrap() = version,
        Err(error) => tracing::debug!(%error, "could not note the master's version"),
    }
}

/// Announces this engine with its resource figures and audio state, and learns
/// which others are alive.
async fn heartbeat(hub: &Arc<Hub>, sampler: &mut Sampler, started_at: u64) {
    let now = unix_now();
    let usage = sampler.sample();
    let relays = hub.snapshot();
    let listeners: usize = relays.iter().map(|relay| relay.listeners()).sum();
    // Playing a fallback file says nothing about whether sources can be reached.
    let live_relays = relays
        .iter()
        .filter(|relay| relay.current_info().is_some() && matches!(relay.source(), Source::Primary | Source::Backup))
        .count();

    if let Some(change) = hub.audio.evaluate(audio_evidence(hub, live_relays).await) {
        match &change {
            Some(state) => tracing::error!(reason = %state.reason, forced = state.forced, "NO AUDIO: leaving the rotation"),
            None => tracing::info!("audio is back: rejoining the rotation"),
        }
    }
    if hub.audio.probe_due() {
        probe_sources(hub);
    }
    let audio = hub.audio.state();

    // Stations this engine currently has no audio for, replaced as a whole.
    let silent_key = format!("silent:{}", hub.cfg.node_id);
    let silent: Vec<(String, String)> = hub
        .silent_stations()
        .into_iter()
        .map(|(slug, entry)| (slug, format!("{}|{}", entry.since, entry.reason)))
        .collect();
    let mut silent_update = redis::pipe();
    silent_update.atomic().del(&silent_key).ignore();
    if !silent.is_empty() {
        silent_update.hset_multiple(&silent_key, &silent).ignore().expire(&silent_key, LIVE_TTL_SECS * 2).ignore();
    }
    let mut redis = hub.redis.clone();
    let _ = silent_update.query_async::<()>(&mut redis).await;

    let key = format!("node:{}", hub.cfg.node_id);
    let result: redis::RedisResult<((), (), (), Vec<String>)> = redis::pipe()
        .hset_multiple(
            &key,
            &[
                ("cpu_percent", format!("{:.1}", usage.cpu_percent)),
                ("cpu_cores", usage.cpu_cores.to_string()),
                ("load_1m", format!("{:.2}", usage.load_1m)),
                ("memory_total", usage.memory_total.to_string()),
                ("memory_available", usage.memory_available.to_string()),
                ("disk_total", usage.disk_total.to_string()),
                ("disk_free", usage.disk_free.to_string()),
                ("network_out_bps", usage.network_out_bps.to_string()),
                ("engine_cpu_percent", format!("{:.2}", usage.engine_cpu_percent)),
                ("engine_memory", usage.engine_memory.to_string()),
                ("listeners", listeners.to_string()),
                ("stations", relays.len().to_string()),
                ("started_at", started_at.to_string()),
                ("reported_at", now.to_string()),
                ("version", env!("CARGO_PKG_VERSION").to_string()),
                ("audio", if audio.is_some() { "no_audio" } else { "ok" }.to_string()),
                ("audio_reason", audio.as_ref().map(|a| a.reason.clone()).unwrap_or_default()),
                ("audio_since", audio.as_ref().map(|a| a.since.to_string()).unwrap_or_default()),
                ("audio_forced", audio.as_ref().is_some_and(|a| a.forced).to_string()),
                // Lets other engines tell a dead station from a server that cannot reach it.
                ("audio_failing", hub.audio.failing(5).into_iter().map(|(slug, _, _)| slug).collect::<Vec<_>>().join(",")),
            ],
        )
        .expire(&key, LIVE_TTL_SECS * 2)
        .cmd("ZADD").arg("engine:nodes").arg(now).arg(&hub.cfg.node_id)
        .cmd("ZRANGEBYSCORE").arg("engine:nodes").arg(now.saturating_sub(LIVE_TTL_SECS as u64)).arg("+inf")
        .query_async(&mut redis)
        .await;
    if let Ok((_, _, _, nodes)) = result {
        hub.set_peers(nodes.into_iter().filter(|n| *n != hub.cfg.node_id).collect());
    }
}

pub async fn run(hub: Arc<Hub>) {
    let mut tick = interval(hub.cfg.stats_flush);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last = Instant::now();
    let mut sampler = Sampler::new(hub.cfg.disk_path.clone());
    let started_at = unix_now();
    loop {
        tick.tick().await;
        let elapsed = last.elapsed();
        last = Instant::now();
        heartbeat(&hub, &mut sampler, started_at).await;
        note_master_version(&hub).await;
        flush_all(&hub, elapsed).await;
    }
}
