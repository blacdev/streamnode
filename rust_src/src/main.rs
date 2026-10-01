mod cluster;
mod config;
mod health;
mod hub;
mod icy;
mod listener;
mod nowplaying;
mod station;
mod stats;
mod sysinfo;
mod upstream;

use std::{sync::Arc, time::Duration};

use axum::{http::StatusCode, routing::any, Router};
use redis::aio::ConnectionManager;
use tokio::signal::unix::{signal, SignalKind};

use crate::{config::Config, hub::Hub};

async fn connect_redis(url: &str) -> ConnectionManager {
    let client = redis::Client::open(url).expect("the Redis URL is not valid");
    loop {
        match ConnectionManager::new(client.clone()).await {
            Ok(manager) => return manager,
            Err(error) => {
                tracing::warn!(%error, "Redis not reachable yet, retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

async fn healthz(axum::extract::State(hub): axum::extract::State<Arc<Hub>>) -> (StatusCode, &'static str) {
    // Failing the check is how HAProxy learns to stop sending listeners here.
    if hub.audio.is_no_audio() {
        return (StatusCode::SERVICE_UNAVAILABLE, "no audio");
    }
    let mut redis = hub.redis.clone();
    match redis::cmd("PING").query_async::<String>(&mut redis).await {
        Ok(_) => (StatusCode::OK, "ok"),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "redis unavailable"),
    }
}

/// Listener streams never end on their own, so shutdown flushes the counters
/// and exits instead of draining connections.
async fn flush_on_shutdown(hub: Arc<Hub>) {
    let mut term = signal(SignalKind::terminate()).expect("cannot install SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("cannot install SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
    tracing::info!("shutting down, flushing counters");
    stats::flush_all(&hub, Duration::ZERO).await;
    std::process::exit(0);
}

/// Only the master's HAProxy may talk to an enrolled engine: it sends a
/// shared secret with every request, including health checks.
async fn require_secret(
    axum::extract::State(secret): axum::extract::State<Arc<str>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let given = request.headers().get("x-engine-auth").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if cluster::secrets_match(given, &secret) {
        next.run(request).await
    } else {
        axum::response::IntoResponse::into_response((StatusCode::FORBIDDEN, "Listeners connect through the gateway"))
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let mut cfg = Config::from_env();
    tracing::info!(node = %cfg.node_id, bind = %cfg.bind, version = env!("CARGO_PKG_VERSION"), "starting audio relay engine");

    let cluster = cluster::resolve(&cfg).await;
    if let Some(allow) = cluster.allow_private_sources {
        cfg.allow_private_sources = allow;
    }
    let redis = connect_redis(&cluster.redis_url).await;
    let bind = cfg.bind.clone();
    let hub = Hub::new(cfg, redis);

    tokio::spawn(stats::run(hub.clone()));
    tokio::spawn(flush_on_shutdown(hub.clone()));

    let mut app = Router::new()
        .route("/healthz", any(healthz))
        .route("/:station", any(listener::handle))
        .fallback(|| async { (StatusCode::NOT_FOUND, "Station not found") })
        .with_state(hub);
    match cluster.engine_secret.filter(|s| !s.is_empty()) {
        Some(secret) => app = app.layer(axum::middleware::from_fn_with_state(Arc::<str>::from(secret), require_secret)),
        None => tracing::warn!("ENGINE_SECRET is not set: this engine accepts listeners from any address"),
    }

    let listener = tokio::net::TcpListener::bind(&bind).await.expect("cannot bind listen address");
    tracing::info!(%bind, "audio relay engine listening");
    axum::serve(listener, app).await.expect("server error");
}
