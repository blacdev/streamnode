//! How an engine obtains its connection to the master node.
//!
//! In order of precedence:
//!   1. `REDIS_URL` in the environment: the engine runs beside the master
//!      (single-server install) and is configured directly.
//!   2. A saved enrolment in `DATA_DIR/cluster.json` from an earlier start.
//!   3. `MASTER_URL` + `JOIN_TOKEN`: the engine enrols itself with the master.
//!   4. Otherwise it waits to be enrolled: the master (told this server's
//!      address and setup key by an administrator) calls
//!      `POST /_cluster/configure`, and the engine then enrols as in 3.
//!
//! Enrolling means presenting a one-time join token to the master, which
//! registers this server with its HAProxy and returns the Redis credentials
//! and the secret HAProxy will use when it sends listeners here.

use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    routing::{any, post},
    Json, Router,
};
use reqwest::Url;
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::config::Config;

#[derive(Clone, Debug, PartialEq)]
pub struct ClusterConfig {
    pub redis_url: String,
    /// Shared secret the master's HAProxy sends with every request.
    pub engine_secret: Option<String>,
    /// The master's setting, so every engine applies the same source policy.
    pub allow_private_sources: Option<bool>,
}

impl ClusterConfig {
    fn to_json(&self, master_url: &str) -> Value {
        json!({
            "master_url": master_url,
            "redis_url": self.redis_url,
            "engine_secret": self.engine_secret,
            "allow_private_sources": self.allow_private_sources,
        })
    }

    fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            redis_url: value.get("redis_url")?.as_str()?.to_string(),
            engine_secret: value.get("engine_secret").and_then(Value::as_str).map(str::to_string),
            allow_private_sources: value.get("allow_private_sources").and_then(Value::as_bool),
        })
    }
}

pub enum JoinError {
    /// The master answered and refused (bad or expired token, wrong address).
    Rejected(String),
    /// The master could not be reached; worth retrying.
    Unreachable(String),
}

fn saved_path(cfg: &Config) -> PathBuf {
    PathBuf::from(&cfg.data_dir).join("cluster.json")
}

fn load_saved(cfg: &Config) -> Option<ClusterConfig> {
    let text = fs::read_to_string(saved_path(cfg)).ok()?;
    ClusterConfig::from_json(&serde_json::from_str(&text).ok()?)
}

/// Written with owner-only permissions: the file holds credentials.
fn save(cfg: &Config, cluster: &ClusterConfig, master_url: &str) -> std::io::Result<()> {
    fs::create_dir_all(&cfg.data_dir)?;
    let path = saved_path(cfg);
    let tmp = path.with_extension("tmp");
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    file.write_all(cluster.to_json(master_url).to_string().as_bytes())?;
    file.sync_all()?;
    fs::rename(tmp, path)
}

/// Builds the Redis URL from the host this engine reached the master on.
fn redis_url(master: &Url, host: Option<&str>, port: u64, password: &str, tls: bool, insecure: bool) -> Result<String, String> {
    let host = match host.filter(|h| !h.is_empty()) {
        Some(host) => host,
        None => master.host_str().ok_or("master URL has no host")?,
    };
    let scheme = if tls { "rediss" } else { "redis" };
    let mut url = Url::parse(&format!("{scheme}://{host}:{port}")).map_err(|e| e.to_string())?;
    url.set_password(Some(password)).map_err(|_| "cannot set Redis password".to_string())?;
    if tls && insecure {
        url.set_fragment(Some("insecure"));
    }
    Ok(url.to_string())
}

fn client(insecure: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(insecure)
        .build()
        .expect("failed to build the enrolment HTTP client")
}

async fn post_join(master: &Url, body: &Value, insecure: bool) -> Result<(StatusCode, String), reqwest::Error> {
    let endpoint = master.join("/api/v1/cluster/join").expect("static path joins any base URL");
    let response = client(insecure)
        .post(endpoint)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let status = response.status();
    Ok((status, response.text().await.unwrap_or_default()))
}

pub async fn join(cfg: &Config, master_url: &str, token: &str) -> Result<ClusterConfig, JoinError> {
    let master = Url::parse(master_url).map_err(|e| JoinError::Rejected(format!("invalid master URL: {e}")))?;
    if !matches!(master.scheme(), "http" | "https") {
        return Err(JoinError::Rejected("the master URL must start with http:// or https://".into()));
    }
    let mut body = json!({ "token": token, "name": cfg.node_id, "port": cfg.advertise_port });
    if let Some(address) = &cfg.advertise_address {
        body["address"] = json!(address);
    }

    // A master that is still on its self-signed certificate fails
    // verification; accepting that must be an explicit choice. A master
    // addressed over plain HTTP gives no evidence either way, so the same
    // choice decides whether its Redis certificate is checked.
    let mut insecure = cfg.allow_insecure_tls && master.scheme() == "http";
    let (status, text) = match post_join(&master, &body, false).await {
        Ok(answer) => answer,
        Err(first) if cfg.allow_insecure_tls && master.scheme() == "https" => {
            tracing::warn!(error = %first, "master certificate not verified; continuing because ALLOW_INSECURE_TLS is set");
            insecure = true;
            post_join(&master, &body, true).await.map_err(|e| JoinError::Unreachable(e.to_string()))?
        }
        Err(error) => return Err(JoinError::Unreachable(error.to_string())),
    };

    let answer: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        let reason = answer["error"]["message"].as_str().map(str::to_string).unwrap_or_else(|| format!("HTTP {status}"));
        return Err(if status.is_client_error() { JoinError::Rejected(reason) } else { JoinError::Unreachable(reason) });
    }

    let redis = &answer["redis"];
    let (Some(port), Some(password)) = (redis["port"].as_u64(), redis["password"].as_str()) else {
        return Err(JoinError::Rejected("the master's answer did not include Redis details".into()));
    };
    let tls = redis["tls"].as_bool().unwrap_or(true);
    // The master says so when its Redis port presents a certificate that does
    // not match (TLS for the domain is handled somewhere else, or Redis is
    // reached by address). That word arrived over the verified join call.
    let redis_insecure = insecure || redis["tls_verify"].as_bool() == Some(false);
    let cluster = ClusterConfig {
        redis_url: redis_url(&master, redis["host"].as_str(), port, password, tls, redis_insecure).map_err(JoinError::Rejected)?,
        engine_secret: answer["engine_secret"].as_str().map(str::to_string),
        allow_private_sources: answer["settings"]["allow_private_sources"].as_bool(),
    };
    if let Err(error) = save(cfg, &cluster, master_url) {
        tracing::error!(%error, path = %saved_path(cfg).display(), "enrolled, but the result could not be saved; this server will have to enrol again after a restart");
    }
    tracing::info!(master = %master_url, name = %cfg.node_id, "enrolled with the master node");
    Ok(cluster)
}

struct Setup {
    cfg: Config,
    result: Mutex<Option<ClusterConfig>>,
    done: Notify,
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

pub fn secrets_match(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn configure(State(setup): State<Arc<Setup>>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    let reply = |status: StatusCode, message: &str| (status, Json(json!({ "message": message })));
    let Some(expected) = setup.cfg.setup_key.as_deref() else {
        return reply(StatusCode::FORBIDDEN, "This server has no setup key; enrol it with a join token instead.");
    };
    if !bearer(&headers).is_some_and(|given| secrets_match(given, expected)) {
        return reply(StatusCode::UNAUTHORIZED, "The setup key is not correct.");
    }
    let (Some(master_url), Some(token)) = (body["master_url"].as_str(), body["token"].as_str()) else {
        return reply(StatusCode::BAD_REQUEST, "master_url and token are required.");
    };
    match join(&setup.cfg, master_url, token).await {
        Ok(cluster) => {
            *setup.result.lock().unwrap() = Some(cluster);
            setup.done.notify_one();
            reply(StatusCode::OK, "Enrolled. The engine is starting.")
        }
        Err(JoinError::Rejected(reason)) => reply(StatusCode::BAD_GATEWAY, &format!("The master refused the enrolment: {reason}")),
        Err(JoinError::Unreachable(reason)) => reply(StatusCode::BAD_GATEWAY, &format!("This server could not reach the master: {reason}")),
    }
}

/// Serves only the setup endpoint until the master enrols this server.
async fn await_setup(cfg: &Config) -> ClusterConfig {
    let setup = Arc::new(Setup { cfg: cfg.clone(), result: Mutex::new(None), done: Notify::new() });
    let app = Router::new()
        .route("/_cluster/configure", post(configure))
        .fallback(any(|| async { (StatusCode::SERVICE_UNAVAILABLE, "awaiting setup") }))
        .with_state(setup.clone());
    let listener = tokio::net::TcpListener::bind(&cfg.bind).await.expect("cannot bind listen address");
    tracing::info!(bind = %cfg.bind, "not enrolled yet: waiting for the master node to complete setup");

    let waiter = setup.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { waiter.done.notified().await })
        .await
        .expect("setup server error");
    let cluster = setup.result.lock().unwrap().take();
    cluster.expect("setup finished without a result")
}

pub async fn resolve(cfg: &Config) -> ClusterConfig {
    if let Some(redis_url) = &cfg.redis_url {
        return ClusterConfig {
            redis_url: redis_url.clone(),
            engine_secret: cfg.engine_secret.clone(),
            allow_private_sources: None,
        };
    }
    if let Some(saved) = load_saved(cfg) {
        tracing::info!("using the saved enrolment");
        return saved;
    }
    if let (Some(master_url), Some(token)) = (&cfg.master_url, &cfg.join_token) {
        let mut wait = Duration::from_secs(2);
        loop {
            match join(cfg, master_url, token).await {
                Ok(cluster) => return cluster,
                Err(JoinError::Rejected(reason)) => {
                    tracing::error!(%reason, "the master refused the join token; waiting to be enrolled from the master instead");
                    break;
                }
                Err(JoinError::Unreachable(reason)) => {
                    tracing::warn!(%reason, retry_in = ?wait, "cannot reach the master yet");
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(Duration::from_secs(30));
                }
            }
        }
    }
    await_setup(cfg).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_url_uses_the_master_host_and_encodes_the_password() {
        let master = Url::parse("https://stream.example.com").unwrap();
        assert_eq!(redis_url(&master, None, 6380, "abc123", true, false).unwrap(), "rediss://:abc123@stream.example.com:6380");
        assert_eq!(redis_url(&master, None, 6380, "p@ss/word", true, true).unwrap(), "rediss://:p%40ss%2Fword@stream.example.com:6380#insecure");
        let by_ip = Url::parse("http://203.0.113.10:8080").unwrap();
        assert_eq!(redis_url(&by_ip, None, 6379, "x", false, true).unwrap(), "redis://:x@203.0.113.10:6379");
        // The master may point slaves at another address for Redis.
        assert_eq!(redis_url(&master, Some("10.0.0.1"), 6380, "x", true, true).unwrap(), "rediss://:x@10.0.0.1:6380#insecure");
    }

    #[test]
    fn saved_enrolment_round_trips() {
        let cluster = ClusterConfig {
            redis_url: "rediss://:pw@m.example:6380".into(),
            engine_secret: Some("s3cret".into()),
            allow_private_sources: Some(false),
        };
        let json = cluster.to_json("https://m.example");
        assert_eq!(ClusterConfig::from_json(&json), Some(cluster));
        assert_eq!(ClusterConfig::from_json(&json!({"master_url": "x"})), None);
    }

    #[test]
    fn secret_comparison() {
        assert!(secrets_match("abc", "abc"));
        assert!(!secrets_match("abc", "abd"));
        assert!(!secrets_match("abc", "abcd"));
    }
}
