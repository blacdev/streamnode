//! Tries a stream or a title address when the dashboard asks, so that its
//! owner can see what the gateway reads from it before saving a station.
//!
//! Requests arrive through Redis (`probe:requests`), which only the gateway's
//! own services can reach, and are answered in `probe:result:{id}`. The
//! address is fetched through the same guard as any source.

use std::{sync::Arc, time::Duration};

use futures_util::StreamExt;
use redis::AsyncCommands;
use serde_json::{json, Value};
use tokio::time::{sleep, timeout, Instant};

use crate::{
    frames::{supported, Framer},
    hub::{unix_now, Hub},
    icy::IcyDemux,
    nowplaying,
};

const POLL: Duration = Duration::from_millis(500);
/// A request older than this has been given up on by whoever made it.
const STALE_SECS: u64 = 15;
const RESULT_TTL_SECS: u64 = 30;
/// How long a stream is listened to for its format and first title.
const LISTEN: Duration = Duration::from_secs(6);
const LISTEN_BYTES: usize = 256 * 1024;

pub async fn run(hub: Arc<Hub>) {
    loop {
        sleep(POLL).await;
        let mut redis = hub.redis.clone();
        let Ok(Some(raw)) = redis.lpop::<_, Option<String>>("probe:requests", None).await else { continue };
        let Ok(request) = serde_json::from_str::<Value>(&raw) else { continue };
        let (Some(id), Some(url)) = (request["id"].as_str().map(str::to_string), request["url"].as_str().map(str::to_string)) else { continue };
        if unix_now().saturating_sub(request["at"].as_u64().unwrap_or(0)) > STALE_SECS {
            continue;
        }
        let kind = request["kind"].as_str().unwrap_or("stream").to_string();
        let hub = hub.clone();
        tokio::spawn(async move {
            let result = match kind.as_str() {
                "titles" => titles(&hub, &url).await,
                _ => stream(&hub, &url).await,
            };
            let mut redis = hub.redis.clone();
            let _: Result<(), _> = redis.set_ex(format!("probe:result:{id}"), result.to_string(), RESULT_TTL_SECS).await;
        });
    }
}

fn failed(reason: String) -> Value {
    json!({ "ok": false, "error": reason })
}

/// Connects to a stream and reports what it is and whether it carries titles.
async fn stream(hub: &Hub, url: &str) -> Value {
    let mut upstream = match hub.connector.connect(url).await {
        Ok(upstream) => upstream,
        Err(reason) => return failed(reason),
    };
    let mut demux = upstream.metaint.map(IcyDemux::new);
    let mut framer = supported(&upstream.info.content_type).then(Framer::new);
    let (mut frames, mut audio) = (Vec::new(), Vec::new());
    let mut title: Option<String> = None;
    let mut bytes = 0;
    let deadline = Instant::now() + LISTEN;
    // Until the format is known and, if the stream carries titles, the first one has come by.
    while bytes < LISTEN_BYTES && (frames.is_empty() && framer.is_some() || demux.is_some() && title.is_none()) {
        let Ok(Some(Ok(chunk))) = timeout(deadline.saturating_duration_since(Instant::now()), upstream.body.next()).await else { break };
        bytes += chunk.len();
        audio.clear();
        match demux.as_mut() {
            Some(demux) => title = demux.feed(chunk, &mut audio).or(title),
            None => audio.push(chunk),
        }
        if let Some(framer) = framer.as_mut().filter(|_| frames.is_empty()) {
            audio.iter().for_each(|piece| framer.push(piece, &mut frames));
        }
    }
    if bytes == 0 {
        return failed("the address answered but sent no audio".into());
    }
    let info = &upstream.info;
    let (artist, song) = nowplaying::split_stream_title(title.as_deref().unwrap_or_default());
    let bitrate = frames.first().map(|frame| frame.bitrate_kbps).filter(|kbps| *kbps > 0).or_else(|| info.header("icy-br")?.parse().ok());
    json!({
        "ok": true,
        "content_type": info.content_type,
        "name": info.header("icy-name"),
        "format": frames.first().map(|frame| frame.format.to_string()),
        "bitrate_kbps": bitrate,
        "carries_titles": demux.is_some(),
        "title": song,
        "artist": artist,
    })
}

/// Fetches a title address and reports what was read from it.
async fn titles(hub: &Hub, url: &str) -> Value {
    let text = match hub.connector.fetch_text(url).await {
        Ok(text) => text,
        Err(reason) => return failed(reason),
    };
    let Some(found) = nowplaying::parse(&text, url) else {
        return failed("the address answered, but no title was found in what it sent".into());
    };
    let artwork_works = if found.artwork.is_empty() { None } else { Some(hub.connector.serves_image(&found.artwork).await) };
    json!({ "ok": true, "title": found.title, "artist": found.artist, "artwork": found.artwork, "artwork_works": artwork_works })
}
