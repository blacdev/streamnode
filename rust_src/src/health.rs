//! Whether this engine can actually deliver audio.
//!
//! An engine can be up, connected to the master and passing health checks
//! while unable to reach station sources (a broken route, a blocked address,
//! DNS trouble on this server). Listeners sent to it would hear nothing. When
//! that happens the engine declares "no audio": its health check fails, so the
//! master's HAProxy stops sending it listeners, it disconnects the listeners it
//! has so their players reconnect elsewhere, and it reports the reason with
//! its heartbeat for the dashboard and API.
//!
//! The difficulty is telling "this server cannot get audio" from "that
//! station is off the air". One station failing is handled per station (see
//! `Hub::mark_silent`): that station is released here and the rest carry on.
//! The whole engine is taken out only when it has no audio at all and is
//! failing on several stations at once, none of which another engine is also
//! failing on; sooner if another engine is demonstrably playing one of them.
//! A station that other engines cannot reach either is the station's problem
//! and is left out of the count. And an engine never takes itself out when no
//! other engine is healthy, so a wide source outage cannot empty the cluster.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::hub::unix_now;

/// Failed attempts older than this no longer count.
const FAILURE_WINDOW: Duration = Duration::from_secs(120);
/// Failed source rounds, across stations, before the engine blames itself.
const FAILED_ROUNDS: u32 = 3;
/// This many different stations must be failing before the whole engine is
/// suspected; a single station is dealt with on its own.
const FAILED_STATIONS: usize = 2;
/// Fewer rounds are enough when another engine is playing the same station.
const FAILED_ROUNDS_WITH_PROOF: u32 = 2;
/// How often a server with no audio re-tests the sources.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct Failure {
    at: Instant,
    /// Unix time of the first failure in this run, to compare with other servers.
    since: u64,
    rounds: u32,
    urls: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NoAudio {
    pub reason: String,
    pub since: u64,
    /// Set by an administrator through the master's API rather than detected.
    pub forced: bool,
}

struct Inner {
    failures: HashMap<String, Failure>,
    state: Option<NoAudio>,
    last_probe: Instant,
}

pub struct AudioHealth {
    inner: Mutex<Inner>,
}

/// What the engine knows about the rest of the cluster at evaluation time.
pub struct Evidence {
    /// Relays on this engine that are currently receiving audio.
    pub live_relays: usize,
    /// Other engines that report audio as fine.
    pub healthy_peers: usize,
    /// Another engine is playing a station this one cannot connect to.
    pub peer_plays_failed_station: bool,
    /// Stations other engines cannot connect to either.
    pub failing_elsewhere: Vec<String>,
    /// Reason given by an administrator, if the state is being forced.
    pub forced: Option<String>,
}

impl AudioHealth {
    pub fn new() -> Self {
        Self { inner: Mutex::new(Inner { failures: HashMap::new(), state: None, last_probe: Instant::now() }) }
    }

    /// Both sources of a station failed to deliver audio.
    pub fn record_failure(&self, slug: &str, urls: Vec<String>) {
        let mut inner = self.inner.lock().unwrap();
        let entry = inner.failures.entry(slug.to_string()).or_insert(Failure { at: Instant::now(), since: unix_now(), rounds: 0, urls: Vec::new() });
        entry.at = Instant::now();
        entry.rounds += 1;
        entry.urls = urls;
    }

    /// Any source delivering audio proves this server can reach the outside.
    pub fn record_success(&self) {
        self.inner.lock().unwrap().failures.clear();
    }

    pub fn is_no_audio(&self) -> bool {
        self.inner.lock().unwrap().state.is_some()
    }

    pub fn state(&self) -> Option<NoAudio> {
        self.inner.lock().unwrap().state.clone()
    }

    /// Stations whose sources recently failed here, most recent first, with
    /// their source URLs and when each started failing (Unix seconds).
    pub fn failing(&self, limit: usize) -> Vec<(String, Vec<String>, u64)> {
        let inner = self.inner.lock().unwrap();
        let mut recent: Vec<_> = inner.failures.iter().filter(|(_, f)| f.at.elapsed() < FAILURE_WINDOW).collect();
        recent.sort_by_key(|(_, f)| f.at.elapsed());
        recent.into_iter().take(limit).map(|(slug, f)| (slug.clone(), f.urls.clone(), f.since)).collect()
    }

    /// True when it is time to re-test the sources (only while detected, not forced).
    pub fn probe_due(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let detected = inner.state.as_ref().is_some_and(|s| !s.forced);
        if detected && inner.last_probe.elapsed() >= PROBE_INTERVAL {
            inner.last_probe = Instant::now();
            return true;
        }
        false
    }

    /// Re-decides the state. Returns the new state when it changed.
    pub fn evaluate(&self, evidence: Evidence) -> Option<Option<NoAudio>> {
        let mut inner = self.inner.lock().unwrap();
        inner.failures.retain(|_, f| f.at.elapsed() < FAILURE_WINDOW);

        let next = if let Some(reason) = evidence.forced {
            match &inner.state {
                Some(current) if current.forced && current.reason == reason => inner.state.clone(),
                _ => Some(NoAudio { reason, since: unix_now(), forced: true }),
            }
        } else {
            // Only failures no other engine shares point at this server.
            let own: Vec<&Failure> = inner
                .failures
                .iter()
                .filter(|(slug, _)| !evidence.failing_elsewhere.contains(slug))
                .map(|(_, failure)| failure)
                .collect();
            let rounds: u32 = own.iter().map(|f| f.rounds).sum();
            let needed = if evidence.peer_plays_failed_station { FAILED_ROUNDS_WITH_PROOF } else { FAILED_ROUNDS };
            let enough = own.len() >= FAILED_STATIONS && rounds >= needed;
            let failing = evidence.live_relays == 0 && enough;
            match &inner.state {
                // Detected earlier: stay out until a source works again, or
                // until there is nobody else left to serve listeners.
                Some(current) if !current.forced => {
                    if inner.failures.is_empty() || evidence.healthy_peers == 0 { None } else { inner.state.clone() }
                }
                // In service (or just released from a forced state).
                _ => {
                    if failing && evidence.healthy_peers > 0 {
                        let mut slugs: Vec<&str> = inner.failures.keys().map(String::as_str).collect();
                        slugs.sort_unstable();
                        let listed = slugs.iter().take(3).copied().collect::<Vec<_>>().join(", ");
                        let more = if slugs.len() > 3 { format!(" and {} more", slugs.len() - 3) } else { String::new() };
                        let proof = if evidence.peer_plays_failed_station { ", while another server is playing them" } else { "" };
                        Some(NoAudio {
                            reason: format!("cannot get audio from the sources of {listed}{more}{proof}"),
                            since: unix_now(),
                            forced: false,
                        })
                    } else {
                        None
                    }
                }
            }
        };

        if next == inner.state {
            return None;
        }
        if next.is_some() {
            inner.last_probe = Instant::now();
        }
        inner.state = next.clone();
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence(live: usize, peers: usize, proof: bool) -> Evidence {
        Evidence { live_relays: live, healthy_peers: peers, peer_plays_failed_station: proof, failing_elsewhere: Vec::new(), forced: None }
    }

    fn fail(health: &AudioHealth, slug: &str, times: u32) {
        for _ in 0..times {
            health.record_failure(slug, vec![format!("http://source/{slug}")]);
        }
    }

    #[test]
    fn a_few_failures_are_not_enough() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 2);
        assert_eq!(health.evaluate(evidence(0, 1, false)), None);
        assert!(!health.is_no_audio());
    }

    #[test]
    fn repeated_failures_with_healthy_peers_take_the_engine_out() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 2);
        fail(&health, "news", 1);
        let change = health.evaluate(evidence(0, 2, false)).expect("state should change").expect("to no audio");
        assert!(!change.forced);
        assert!(change.reason.contains("jazz") && change.reason.contains("news"));
        assert!(health.is_no_audio());
    }

    #[test]
    fn proof_from_a_peer_needs_fewer_failures() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 1);
        fail(&health, "news", 1);
        assert_eq!(health.evaluate(evidence(0, 1, false)), None);
        assert!(health.evaluate(evidence(0, 1, true)).unwrap().unwrap().reason.contains("another server is playing them"));
    }

    #[test]
    fn one_station_failing_never_takes_the_engine_out_even_with_proof() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 10);
        assert_eq!(health.evaluate(evidence(0, 3, true)), None, "a single station is released on its own instead");
    }

    #[test]
    fn one_silent_station_without_proof_is_the_stations_problem() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 10);
        assert_eq!(health.evaluate(evidence(0, 3, false)), None);
    }

    #[test]
    fn stations_failing_everywhere_do_not_count_against_this_engine() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 5);
        fail(&health, "news", 5);
        let shared = Evidence { failing_elsewhere: vec!["jazz".into(), "news".into()], ..evidence(0, 2, false) };
        assert_eq!(health.evaluate(shared), None);
        let partly = Evidence { failing_elsewhere: vec!["jazz".into()], ..evidence(0, 2, false) };
        assert_eq!(health.evaluate(partly), None, "one unexplained station is not enough");
    }

    #[test]
    fn never_the_last_engine_standing() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 10);
        fail(&health, "news", 10);
        assert_eq!(health.evaluate(evidence(0, 0, false)), None, "with no healthy peer the sources are the likelier cause");
        // And an engine already out returns if every other engine goes away.
        health.evaluate(evidence(0, 1, false));
        assert!(health.is_no_audio());
        assert_eq!(health.evaluate(evidence(0, 0, false)), Some(None));
    }

    #[test]
    fn audio_flowing_on_any_station_means_the_engine_is_fine() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 10);
        assert_eq!(health.evaluate(evidence(1, 3, true)), None);
    }

    #[test]
    fn a_working_source_brings_it_back() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 3);
        fail(&health, "news", 1);
        health.evaluate(evidence(0, 1, false));
        assert!(health.is_no_audio());
        assert_eq!(health.evaluate(evidence(0, 1, false)), None, "stays out while nothing has worked");
        health.record_success();
        assert_eq!(health.evaluate(evidence(0, 1, false)), Some(None));
    }

    #[test]
    fn forced_state_overrides_detection_and_clears_cleanly() {
        let health = AudioHealth::new();
        let forced = |reason: &str| Evidence { forced: Some(reason.to_string()), ..evidence(5, 0, false) };
        let state = health.evaluate(forced("maintenance")).unwrap().unwrap();
        assert!(state.forced && state.reason == "maintenance");
        assert_eq!(health.evaluate(forced("maintenance")), None, "unchanged while the same override stands");
        assert!(!health.probe_due(), "a forced state is not probed away");
        assert_eq!(health.evaluate(evidence(5, 0, false)), Some(None));
    }

    #[test]
    fn failing_lists_recent_stations_with_their_sources() {
        let health = AudioHealth::new();
        fail(&health, "jazz", 1);
        let listed = health.failing(5);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].0.as_str(), &listed[0].1), ("jazz", &vec!["http://source/jazz".to_string()]));
        assert!(listed[0].2 > 0);
    }
}
