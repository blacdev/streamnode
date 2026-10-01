//! Listener-facing HTTP: the stream itself, playlist files and CORS.

use std::{collections::VecDeque, convert::Infallible, sync::Arc};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Response, StatusCode},
    response::IntoResponse,
};
use bytes::Bytes;
use futures_util::stream;
use tokio::{
    sync::{broadcast, watch},
    time::timeout,
};

use crate::{
    hub::{Hub, ListenerGuard, Status},
    icy::{IcyMux, METAINT},
    nowplaying::NowPlaying,
    station::{valid_slug, Station},
    upstream::StreamInfo,
};

/// Source headers forwarded to listeners unchanged.
const PASSTHROUGH: &[&str] = &[
    "icy-name", "icy-genre", "icy-br", "icy-sr", "icy-url", "icy-pub", "icy-description", "ice-audio-info",
];
const EXPOSED: &str = "icy-metaint, icy-name, icy-genre, icy-br, icy-sr, icy-url, icy-description, ice-audio-info";

enum Wanted {
    Stream,
    M3u,
    Pls,
}

/// `/jazz`, `/jazz.mp3` and `/jazz.aac` are the stream; `/jazz.m3u` and
/// `/jazz.pls` are playlist files pointing at it.
fn parse_path(raw: &str) -> Option<(&str, Wanted)> {
    let (slug, wanted) = match raw.rsplit_once('.') {
        Some((slug, "m3u")) => (slug, Wanted::M3u),
        Some((slug, "pls")) => (slug, Wanted::Pls),
        Some((slug, "mp3" | "aac" | "ogg" | "opus" | "flac")) => (slug, Wanted::Stream),
        _ => (raw, Wanted::Stream),
    };
    valid_slug(slug).then_some((slug, wanted))
}

fn cors(response: &mut Response<Body>) {
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, HEAD, OPTIONS"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Origin, Accept, Range, Content-Type, X-Requested-With, Icy-MetaData"),
    );
    headers.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static(EXPOSED));
}

fn plain(status: StatusCode, message: &'static str) -> Response<Body> {
    let mut response = (status, message).into_response();
    cors(&mut response);
    response
}

fn set(headers: &mut HeaderMap, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::from_bytes(value.as_bytes())) {
        headers.insert(name, value);
    }
}

fn stream_headers(response: &mut Response<Body>, station: &Station, info: Option<&StreamInfo>, with_meta: bool) {
    let headers = response.headers_mut();
    let content_type = info.map(|i| i.content_type.as_str()).filter(|c| !c.is_empty()).unwrap_or("audio/mpeg");
    set(headers, "content-type", content_type);
    set(headers, "icy-name", &station.name);
    if let Some(info) = info {
        for name in PASSTHROUGH {
            if let Some(value) = info.header(name) {
                set(headers, name, value);
            }
        }
    }
    if with_meta {
        set(headers, "icy-metaint", &METAINT.to_string());
    }
    set(headers, "cache-control", "no-cache, no-store, must-revalidate");
    set(headers, "pragma", "no-cache");
    set(headers, "expires", "Mon, 26 Jul 1997 05:00:00 GMT");
    set(headers, "x-content-type-options", "nosniff");
    set(headers, "accept-ranges", "none");
    cors(response);
}

fn public_url(headers: &HeaderMap, slug: &str) -> String {
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    let scheme = text("x-forwarded-proto").filter(|s| *s == "https").unwrap_or("http");
    let host = text("host").unwrap_or("localhost");
    format!("{scheme}://{host}/{slug}")
}

fn playlist(wanted: Wanted, station: &Station, url: &str) -> Response<Body> {
    let name: String = station.name.chars().filter(|c| !c.is_control()).collect();
    let (content_type, body) = match wanted {
        Wanted::Pls => (
            "audio/x-scpls",
            format!("[playlist]\nNumberOfEntries=1\nFile1={url}\nTitle1={name}\nLength1=-1\nVersion=2\n"),
        ),
        _ => ("audio/x-mpegurl", format!("#EXTM3U\n#EXTINF:-1,{name}\n{url}\n")),
    };
    let mut response = (StatusCode::OK, body).into_response();
    set(response.headers_mut(), "content-type", content_type);
    set(response.headers_mut(), "cache-control", "no-cache");
    cors(&mut response);
    response
}

struct ListenerStream {
    guard: ListenerGuard,
    burst: VecDeque<Bytes>,
    rx: broadcast::Receiver<Bytes>,
    now_playing: watch::Receiver<Arc<NowPlaying>>,
    mux: Option<IcyMux>,
}

impl ListenerStream {
    async fn next(&mut self) -> Option<Bytes> {
        let chunk = match self.burst.pop_front() {
            Some(chunk) => chunk,
            None => loop {
                match self.rx.recv().await {
                    Ok(chunk) => break chunk,
                    // A listener that cannot keep up skips ahead rather than
                    // holding memory; players resync on the next audio frame.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            },
        };
        let out = match self.mux.as_mut() {
            Some(mux) => {
                let np = self.now_playing.borrow().clone();
                mux.wrap(&chunk, &np.stream_title(), &np.artwork)
            }
            None => chunk,
        };
        self.guard.relay.add_bytes(out.len());
        Some(out)
    }
}

pub async fn handle(
    State(hub): State<Arc<Hub>>,
    Path(raw): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response<Body> {
    if method == Method::OPTIONS {
        return plain(StatusCode::NO_CONTENT, "");
    }
    if method != Method::GET && method != Method::HEAD {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let Some((slug, wanted)) = parse_path(&raw) else {
        return plain(StatusCode::NOT_FOUND, "Station not found");
    };

    // HAProxy retries a 503 on another server, so the listener still gets audio.
    if hub.audio.is_no_audio() && method == Method::GET {
        return plain(StatusCode::SERVICE_UNAVAILABLE, "This server has no audio");
    }

    let mut redis = hub.redis.clone();
    let station = match Station::load(&mut redis, slug).await {
        Ok(Some(station)) => station,
        Ok(None) => return plain(StatusCode::NOT_FOUND, "Station not found"),
        Err(error) => {
            tracing::error!(%error, "station lookup failed");
            return plain(StatusCode::SERVICE_UNAVAILABLE, "Station registry unavailable");
        }
    };
    if !station.active {
        return plain(StatusCode::SERVICE_UNAVAILABLE, "Station suspended");
    }

    if !matches!(wanted, Wanted::Stream) {
        return playlist(wanted, &station, &public_url(&headers, slug));
    }

    // HEAD is answered without touching the source, so probes from players
    // and directories neither start a relay nor count as listeners.
    if method == Method::HEAD {
        let info = hub.get(slug).and_then(|relay| relay.current_info());
        let mut response = Response::new(Body::empty());
        stream_headers(&mut response, &station, info.as_deref(), false);
        return response;
    }

    // Only limited stations pay for the extra lookup of other engines' counts.
    let mut elsewhere = 0usize;
    if station.max_listeners > 0 {
        let peers = hub.peers();
        if !peers.is_empty() {
            let counts: Vec<Option<usize>> = redis::cmd("HMGET")
                .arg(format!("conns:{slug}"))
                .arg(&peers)
                .query_async(&mut redis)
                .await
                .unwrap_or_default();
            elsewhere = counts.into_iter().flatten().sum();
        }
    }
    // This engine recently found no audio for the station: answer at once,
    // without starting a relay. HAProxy tries the listener on another server.
    if hub.is_silent(&station) {
        return plain(StatusCode::BAD_GATEWAY, "Station source offline");
    }

    let Ok(mut guard) = hub.acquire(&station, elsewhere) else {
        return plain(StatusCode::SERVICE_UNAVAILABLE, "Listener limit reached");
    };
    if station.max_listeners > 0 {
        // Tell the other engines at once rather than at the next stats flush,
        // so listeners arriving close together cannot overshoot the limit.
        let key = format!("conns:{slug}");
        let _ = redis::pipe()
            .hset(&key, &hub.cfg.node_id, guard.relay.connections())
            .expire(&key, 15)
            .query_async::<()>(&mut redis)
            .await;
    }

    let mut status = guard.relay.status();
    let ready = timeout(hub.cfg.ready_timeout, status.wait_for(|s| !matches!(s, Status::Connecting)))
        .await
        .ok()
        .and_then(|r| r.ok().map(|s| s.clone()));
    let info = match ready {
        Some(Status::Live(info)) => info,
        Some(_) => return plain(StatusCode::BAD_GATEWAY, "Station source offline"),
        None => return plain(StatusCode::GATEWAY_TIMEOUT, "Station source did not respond"),
    };
    let Some((burst, rx)) = guard.relay.subscribe() else {
        return plain(StatusCode::SERVICE_UNAVAILABLE, "Station restarting, retry");
    };

    let with_meta = headers.get("icy-metadata").and_then(|v| v.to_str().ok()).map(str::trim) == Some("1");
    guard.start_streaming();
    let listener = ListenerStream {
        now_playing: guard.relay.now_playing(),
        guard,
        burst,
        rx,
        mux: with_meta.then(IcyMux::new),
    };
    let body = Body::from_stream(stream::unfold(listener, |mut listener| async move {
        listener.next().await.map(|chunk| (Ok::<_, Infallible>(chunk), listener))
    }));

    let mut response = Response::new(body);
    stream_headers(&mut response, &station, Some(&info), with_meta);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_variants() {
        assert!(matches!(parse_path("jazz"), Some(("jazz", Wanted::Stream))));
        assert!(matches!(parse_path("jazz.mp3"), Some(("jazz", Wanted::Stream))));
        assert!(matches!(parse_path("jazz.m3u"), Some(("jazz", Wanted::M3u))));
        assert!(matches!(parse_path("jazz.pls"), Some(("jazz", Wanted::Pls))));
        assert!(parse_path("Jazz").is_none());
        assert!(parse_path("jazz.exe").is_none());
    }

    #[test]
    fn playlist_urls_follow_the_forwarded_scheme() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("stream.example.com"));
        assert_eq!(public_url(&headers, "jazz"), "http://stream.example.com/jazz");
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        assert_eq!(public_url(&headers, "jazz"), "https://stream.example.com/jazz");
    }
}
