//! The service log: what happened to stations and to this engine, for the
//! dashboard's Logs.
//!
//! Events are queued in Redis (`events:queue`) and moved into the database by
//! the management service, which also prunes them after the retention period
//! set in the dashboard. The queue is capped, so an outage of the management
//! service cannot fill Redis: the oldest events are dropped first.

use std::sync::{Arc, OnceLock};

use redis::aio::ConnectionManager;
use serde_json::json;
use tokio::sync::mpsc;

use crate::hub::Hub;

const QUEUE: &str = "events:queue";
/// Most events kept waiting for the management service.
const QUEUE_CAP: isize = 20_000;
/// Most events sent to Redis in one go.
const BATCH: usize = 200;

/// Events go out through one writer, so they reach the log in the order they happened.
static OUTBOX: OnceLock<mpsc::UnboundedSender<String>> = OnceLock::new();

/// Starts the writer. Events recorded before it starts, or in tests, are dropped.
pub fn start(redis: ConnectionManager) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    if OUTBOX.set(tx).is_err() {
        return;
    }
    tokio::spawn(async move {
        let mut redis = redis;
        let mut batch = Vec::with_capacity(BATCH);
        while rx.recv_many(&mut batch, BATCH).await > 0 {
            let mut pipe = redis::pipe();
            pipe.rpush(QUEUE, &batch).ignore().ltrim(QUEUE, -QUEUE_CAP, -1).ignore();
            // Redis being briefly away costs these events, never the audio.
            let _: redis::RedisResult<()> = pipe.query_async(&mut redis).await;
            batch.clear();
        }
    });
}

#[derive(Clone, Copy)]
pub enum Level {
    Info,
    Warning,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warning => "warning",
            Level::Error => "error",
        }
    }
}

/// Records one event. Never waits and never fails: the log must not slow audio down.
pub fn record(hub: &Arc<Hub>, level: Level, category: &'static str, station: Option<&str>, message: impl Into<String>) {
    let event = json!({
        "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
        "level": level.as_str(),
        "category": category,
        "station": station,
        "node": hub.cfg.node_id,
        "message": message.into(),
    })
    .to_string();
    if let Some(outbox) = OUTBOX.get() {
        let _ = outbox.send(event);
    }
}
