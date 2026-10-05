//! Outbound connections to station sources.
//!
//! Standard HTTP(S) sources go through reqwest. SHOUTcast v1 servers answer
//! with a non-HTTP `ICY 200 OK` status line, so a failed plain-HTTP attempt is
//! retried with a minimal raw client. Every connection is checked against the
//! private-address filter, including redirect hops.

use std::{
    error::Error,
    io,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use bytes::{Bytes, BytesMut};
use futures_util::{
    stream::{self, BoxStream},
    StreamExt,
};
use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    redirect, Client, Url,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use url::Host;

use crate::config::Config;

const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_PLAYLIST_HOPS: usize = 2;

pub type Body = BoxStream<'static, io::Result<Bytes>>;

/// What the source told us about the stream; passed through to listeners.
#[derive(Debug, Default)]
pub struct StreamInfo {
    pub content_type: String,
    /// `icy-*` / `ice-audio-info` response headers, lower-cased names.
    pub headers: Vec<(String, String)>,
}

impl StreamInfo {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

pub struct Upstream {
    pub info: StreamInfo,
    pub metaint: Option<usize>,
    pub body: Body,
}

/// True for addresses reachable on the public internet.
pub fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (o[1] & 0xfe) == 18)
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ip_is_public(IpAddr::V4(v4));
            }
            let s = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] == 0x2001 && s[1] == 0x0db8)
                || (s[0] == 0x0064 && s[1] == 0xff9b))
        }
    }
}

/// DNS resolver that drops non-public answers, so a hostname cannot be used
/// to reach the internal network.
struct GuardedResolver {
    allow_private: bool,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allow_private = self.allow_private;
        Box::pin(async move {
            let host = name.as_str().to_owned();
            let addrs = resolve_host(&host, 0, allow_private).await?;
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

async fn resolve_host(host: &str, port: u16, allow_private: bool) -> io::Result<Vec<SocketAddr>> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await?
        .filter(|a| allow_private || ip_is_public(a.ip()))
        .collect();
    if addrs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{host} does not resolve to a public address"),
        ));
    }
    Ok(addrs)
}

fn literal_ip(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
        Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
        Host::Domain(_) => None,
    }
}

fn describe(err: &dyn Error) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(inner) = source {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        source = inner.source();
    }
    text
}

#[derive(Clone)]
pub struct Connector {
    client: Client,
    allow_private: bool,
    connect_timeout: Duration,
    stall_timeout: Duration,
    user_agent: String,
}

impl Connector {
    pub fn new(cfg: &Config) -> Self {
        let allow_private = cfg.allow_private_sources;
        let client = Client::builder()
            .user_agent(cfg.user_agent.clone())
            .connect_timeout(cfg.connect_timeout)
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .dns_resolver(Arc::new(GuardedResolver { allow_private }))
            .redirect(redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 5 {
                    attempt.error("too many redirects")
                } else if !allow_private
                    && literal_ip(attempt.url()).is_some_and(|ip| !ip_is_public(ip))
                {
                    attempt.error("redirect to a non-public address")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .expect("failed to build the upstream HTTP client");
        Self {
            client,
            allow_private,
            connect_timeout: cfg.connect_timeout,
            stall_timeout: cfg.stall_timeout,
            user_agent: cfg.user_agent.clone(),
        }
    }

    fn check_url(&self, raw: &str) -> Result<Url, String> {
        let url = Url::parse(raw).map_err(|e| format!("invalid URL: {e}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!("unsupported scheme {}", url.scheme()));
        }
        if url.host().is_none() {
            return Err("URL has no host".into());
        }
        if !self.allow_private && literal_ip(&url).is_some_and(|ip| !ip_is_public(ip)) {
            return Err("source address is not public".into());
        }
        Ok(url)
    }

    /// Connects to a source and waits for the first audio bytes, so a source
    /// that accepts connections but sends nothing is never reported as live.
    pub async fn connect(&self, raw: &str) -> Result<Upstream, String> {
        let mut target = raw.to_string();
        for _ in 0..=MAX_PLAYLIST_HOPS {
            let mut up = self.open(&target).await?;
            let kind = up.info.content_type.to_ascii_lowercase();
            if kind.contains("application/vnd.apple.mpegurl") || kind.contains("application/dash") {
                return Err("HLS/DASH sources are not supported; use the direct stream URL".into());
            }
            if kind.contains("mpegurl") || kind.contains("scpls") {
                let text = read_text(&mut up.body, self.stall_timeout).await?;
                if text.contains("#EXT-X-") {
                    return Err("HLS sources are not supported; use the direct stream URL".into());
                }
                target = playlist_entry(&text)
                    .ok_or_else(|| "playlist contains no stream URL".to_string())?;
                continue;
            }
            if kind.starts_with("text/") || kind.contains("json") {
                return Err(format!("source returned {kind}, not an audio stream"));
            }

            let first = loop {
                match timeout(self.stall_timeout, up.body.next()).await {
                    Err(_) => return Err("source connected but sent no audio".into()),
                    Ok(None) => return Err("source closed before sending audio".into()),
                    Ok(Some(Err(e))) => return Err(describe(&e)),
                    Ok(Some(Ok(chunk))) if chunk.is_empty() => continue,
                    Ok(Some(Ok(chunk))) => break chunk,
                }
            };
            up.body = stream::once(async move { Ok(first) }).chain(up.body).boxed();
            return Ok(up);
        }
        Err("too many nested playlists".into())
    }

    async fn open(&self, raw: &str) -> Result<Upstream, String> {
        let url = self.check_url(raw)?;
        let request = self.client.get(url.clone()).header("Icy-MetaData", "1").send();
        let response = match timeout(self.connect_timeout + self.stall_timeout, request).await {
            Err(_) => return Err("timed out waiting for response headers".into()),
            Ok(Ok(response)) => response,
            Ok(Err(e)) => {
                if url.scheme() == "http" && !e.is_connect() && !e.is_timeout() {
                    return self
                        .open_icy(&url)
                        .await
                        .map_err(|icy| format!("{}; ICY fallback: {icy}", describe(&e)));
                }
                return Err(describe(&e));
            }
        };
        if !response.status().is_success() {
            return Err(format!("source answered HTTP {}", response.status().as_u16()));
        }

        let mut info = StreamInfo::default();
        let mut metaint = None;
        for (name, value) in response.headers() {
            let name = name.as_str();
            let value = String::from_utf8_lossy(value.as_bytes()).trim().to_string();
            collect_header(name, value, &mut info, &mut metaint);
        }
        let body = response.bytes_stream().map(|r| r.map_err(io::Error::other)).boxed();
        Ok(Upstream { info, metaint, body })
    }

    /// Raw client for SHOUTcast v1 (`ICY 200 OK`) sources.
    async fn open_icy(&self, url: &Url) -> Result<Upstream, String> {
        let port = url.port_or_known_default().unwrap_or(80);
        let (addrs, host_header) = match url.host().ok_or("URL has no host")? {
            Host::Domain(d) => (
                resolve_host(d, port, self.allow_private).await.map_err(|e| e.to_string())?,
                d.to_string(),
            ),
            Host::Ipv4(ip) => (vec![SocketAddr::new(ip.into(), port)], ip.to_string()),
            Host::Ipv6(ip) => (vec![SocketAddr::new(ip.into(), port)], format!("[{ip}]")),
        };
        let mut sock = timeout(self.connect_timeout, TcpStream::connect(&addrs[..]))
            .await
            .map_err(|_| "connect timed out".to_string())?
            .map_err(|e| e.to_string())?;

        let path = match url.query() {
            Some(q) => format!("{}?{}", url.path(), q),
            None => url.path().to_string(),
        };
        let host_header = if port == 80 { host_header } else { format!("{host_header}:{port}") };
        let request = format!(
            "GET {path} HTTP/1.0\r\nHost: {host_header}\r\nUser-Agent: {}\r\nIcy-MetaData: 1\r\nAccept: */*\r\nConnection: close\r\n\r\n",
            self.user_agent
        );
        sock.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;

        let mut buf = BytesMut::with_capacity(8192);
        let head_end = loop {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
            if buf.len() > MAX_HEAD_BYTES {
                return Err("response headers too large".into());
            }
            let read = timeout(self.stall_timeout, sock.read_buf(&mut buf))
                .await
                .map_err(|_| "timed out waiting for response headers".to_string())?
                .map_err(|e| e.to_string())?;
            if read == 0 {
                return Err("connection closed before headers completed".into());
            }
        };
        let head = buf.split_to(head_end);
        let head = String::from_utf8_lossy(&head);
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap_or_default();
        if status.split_whitespace().nth(1) != Some("200") {
            return Err(format!("source answered `{status}`"));
        }

        let mut info = StreamInfo::default();
        let mut metaint = None;
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                collect_header(
                    &name.trim().to_ascii_lowercase(),
                    value.trim().to_string(),
                    &mut info,
                    &mut metaint,
                );
            }
        }

        let leftover = buf.freeze();
        let rest = stream::unfold(sock, |mut sock| async move {
            let mut chunk = BytesMut::with_capacity(8192);
            match sock.read_buf(&mut chunk).await {
                Ok(0) => None,
                Ok(_) => Some((Ok(chunk.freeze()), sock)),
                Err(e) => Some((Err(e), sock)),
            }
        });
        let body = stream::once(async move { Ok(leftover) }).chain(rest).boxed();
        Ok(Upstream { info, metaint, body })
    }

    /// Fetches a small text document (a station's now-playing endpoint).
    pub async fn fetch_text(&self, raw: &str) -> Result<String, String> {
        let url = self.check_url(raw)?;
        let response = timeout(self.connect_timeout, self.client.get(url).send())
            .await
            .map_err(|_| "timed out".to_string())?
            .map_err(|e| describe(&e))?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let mut body = response.bytes_stream().map(|r| r.map_err(io::Error::other)).boxed();
        read_text(&mut body, self.connect_timeout).await
    }

    /// Whether an address answers with an image. Only the response's headers
    /// are read; the picture itself is not downloaded.
    pub async fn serves_image(&self, raw: &str) -> bool {
        let Ok(url) = self.check_url(raw) else { return false };
        let Ok(Ok(response)) = timeout(self.connect_timeout, self.client.get(url).send()).await else { return false };
        if !response.status().is_success() {
            return false;
        }
        // Some servers send pictures without saying what they are; a page of text is what a dead link looks like.
        response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_none_or(|kind| {
            let kind = kind.trim().to_ascii_lowercase();
            kind.starts_with("image/") || kind.ends_with("/octet-stream")
        })
    }
}

fn collect_header(name: &str, value: String, info: &mut StreamInfo, metaint: &mut Option<usize>) {
    if value.is_empty() {
        return;
    }
    match name {
        "content-type" => info.content_type = value,
        "icy-metaint" => *metaint = value.parse().ok().filter(|n| *n > 0),
        "ice-audio-info" => info.headers.push((name.to_string(), value)),
        n if n.starts_with("icy-") => info.headers.push((name.to_string(), value)),
        _ => {}
    }
}

async fn read_text(body: &mut Body, per_read: Duration) -> Result<String, String> {
    let mut buf = Vec::new();
    while buf.len() < MAX_TEXT_BYTES {
        match timeout(per_read, body.next()).await {
            Err(_) => return Err("timed out reading response".into()),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(describe(&e)),
            Ok(Some(Ok(chunk))) => buf.extend_from_slice(&chunk),
        }
    }
    buf.truncate(MAX_TEXT_BYTES);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// First stream URL in an M3U or PLS playlist.
pub fn playlist_entry(text: &str) -> Option<String> {
    for line in text.lines().map(str::trim) {
        let candidate = match line.split_once('=') {
            Some((key, value)) if key.to_ascii_lowercase().starts_with("file") => value.trim(),
            _ => line,
        };
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            return Some(candidate.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_internal_addresses() {
        for ip in [
            "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1",
            "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1",
        ] {
            assert!(!ip_is_public(ip.parse().unwrap()), "{ip} must be blocked");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(ip_is_public(ip.parse().unwrap()), "{ip} must be allowed");
        }
    }

    #[test]
    fn finds_stream_url_in_playlists() {
        let m3u = "#EXTM3U\n#EXTINF:-1,Station\nhttp://a.example/live\n";
        assert_eq!(playlist_entry(m3u).as_deref(), Some("http://a.example/live"));
        let pls = "[playlist]\nNumberOfEntries=1\nFile1=https://b.example/stream?x=1\nTitle1=B\n";
        assert_eq!(playlist_entry(pls).as_deref(), Some("https://b.example/stream?x=1"));
        assert_eq!(playlist_entry("nothing here"), None);
    }
}
