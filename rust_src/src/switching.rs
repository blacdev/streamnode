//! "Switch to this stream" from the dashboard.
//!
//! The management service writes requests into the Redis hash
//! `switch:requests`, one field per station: `{"source": "primary"|"backup",
//! "id": <unique>, "at": <unix seconds>}`. Every engine reads the hash each
//! second and keeps the recent ones; each station's relay acts on a request
//! once (see `playout`). A request only ever moves a station up, from the
//! fallback file to a stream or from the backup to the primary, and only once
//! that stream is heard to have audio.

use std::{collections::HashMap, sync::Arc, time::Duration};

use redis::AsyncCommands;
use serde_json::Value;
use tokio::time::sleep;

use crate::hub::{unix_now, Hub, Source, SwitchRequest};

const KEY: &str = "switch:requests";
const POLL: Duration = Duration::from_secs(1);
/// A request older than this is no longer acted on.
pub const FRESH_SECS: u64 = 30;

pub async fn run(hub: Arc<Hub>) {
    loop {
        sleep(POLL).await;
        let mut redis = hub.redis.clone();
        let Ok(raw) = redis.hgetall::<_, HashMap<String, String>>(KEY).await else { continue };
        let now = unix_now();
        hub.set_switch_requests(raw.into_iter().filter_map(|(slug, value)| parse(&value, now).map(|request| (slug, request))).collect());
    }
}

fn parse(value: &str, now: u64) -> Option<SwitchRequest> {
    let request: Value = serde_json::from_str(value).ok()?;
    if now.saturating_sub(request["at"].as_u64()?) > FRESH_SECS {
        return None;
    }
    let source = match request["source"].as_str()? {
        "primary" => Source::Primary,
        "backup" => Source::Backup,
        _ => return None,
    };
    Some(SwitchRequest { source, id: request["id"].as_u64()? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_fresh_requests_only() {
        let now = 1_000_000;
        assert_eq!(parse(r#"{"source":"backup","id":7,"at":999990}"#, now), Some(SwitchRequest { source: Source::Backup, id: 7 }));
        assert_eq!(parse(r#"{"source":"primary","id":8,"at":999000}"#, now), None, "too old");
        assert_eq!(parse(r#"{"source":"fallback","id":9,"at":1000000}"#, now), None, "only streams");
        assert_eq!(parse("not json", now), None);
    }
}
