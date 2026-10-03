use std::{env, str::FromStr, time::Duration};

/// Runtime settings, all overridable through environment variables.
#[derive(Clone, Debug)]
pub struct Config {
    /// Set only when the engine runs beside the master; otherwise the engine
    /// enrols with the master and receives it (see `cluster`).
    pub redis_url: Option<String>,
    /// Secret the master's HAProxy sends with each request (single-server installs).
    pub engine_secret: Option<String>,
    /// Master node to enrol with, e.g. `https://stream.example.com`.
    pub master_url: Option<String>,
    pub join_token: Option<String>,
    /// Lets an administrator finish enrolment from the master's dashboard.
    pub setup_key: Option<String>,
    /// Address and port the master should use to reach this engine. The
    /// address defaults to wherever the join request came from.
    pub advertise_address: Option<String>,
    pub advertise_port: u16,
    /// The master's API, for an engine on the same server; a slave uses the
    /// address it enrolled with.
    pub admin_url: Option<String>,
    /// Accept a master whose certificate cannot be verified (self-signed).
    pub allow_insecure_tls: bool,
    /// Where the enrolment is saved between restarts.
    pub data_dir: String,
    /// Identifies this engine among several sharing one Redis.
    pub node_id: String,
    pub bind: String,
    /// How long a relay stays connected to its source after the last listener leaves.
    pub idle_grace: Duration,
    /// A source that sends nothing for this long is treated as dead.
    pub stall_timeout: Duration,
    pub connect_timeout: Duration,
    /// While on the backup source, how often the primary is probed.
    pub primary_retry: Duration,
    /// How long a new listener waits for the source before getting a 502.
    pub ready_timeout: Duration,
    /// How often an active relay re-reads its station profile from Redis.
    pub config_refresh: Duration,
    /// How often a station's metadata URL is polled while it has listeners.
    pub metadata_poll: Duration,
    /// How often counters are pushed to Redis.
    pub stats_flush: Duration,
    /// Recent audio replayed to a new listener so playback starts instantly.
    pub burst_bytes: usize,
    /// Permit sources on private/loopback addresses (development, LAN encoders).
    pub allow_private_sources: bool,
    pub user_agent: String,
    /// Failed source rounds after which a station is given up on here: its
    /// listeners are released and its relay stopped.
    pub station_fail_rounds: u32,
    /// How long this engine then refuses the station before trying its sources again.
    pub station_retry: Duration,
    /// Directory shared with the host. A slave engine writes its master's
    /// version there, which this server's updater then follows.
    pub control_dir: Option<String>,
    /// Filesystem whose free space is reported as this server's disk.
    pub disk_path: String,
}

fn var<T: FromStr>(key: &str, default: T) -> T {
    env::var(key).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(default)
}

fn opt(key: &str) -> Option<String> {
    env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn secs(key: &str, default: u64) -> Duration {
    Duration::from_secs(var(key, default).max(1))
}

/// `NODE_ID`, else the host name (the container name under Docker).
fn node_id() -> String {
    let raw = env::var("NODE_ID")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| env::var("HOSTNAME").ok())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .unwrap_or_else(|| "engine".to_string());
    let clean: String = raw
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .take(64)
        .collect();
    if clean.is_empty() { "engine".to_string() } else { clean }
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            node_id: node_id(),
            redis_url: opt("REDIS_URL"),
            engine_secret: opt("ENGINE_SECRET"),
            master_url: opt("MASTER_URL"),
            join_token: opt("JOIN_TOKEN"),
            setup_key: opt("NODE_SETUP_KEY"),
            advertise_address: opt("ADVERTISE_ADDRESS"),
            advertise_port: var("ADVERTISE_PORT", 3000u16),
            admin_url: opt("ADMIN_URL"),
            allow_insecure_tls: var("ALLOW_INSECURE_TLS", false),
            data_dir: var("DATA_DIR", "/data".to_string()),
            bind: var("BIND_ADDR", "0.0.0.0:3000".to_string()),
            idle_grace: secs("IDLE_GRACE_SECS", 10),
            stall_timeout: secs("STALL_TIMEOUT_SECS", 10),
            connect_timeout: secs("CONNECT_TIMEOUT_SECS", 5),
            primary_retry: secs("PRIMARY_RETRY_SECS", 30),
            ready_timeout: secs("READY_TIMEOUT_SECS", 15),
            config_refresh: secs("CONFIG_REFRESH_SECS", 5),
            metadata_poll: secs("METADATA_POLL_SECS", 10),
            stats_flush: secs("STATS_FLUSH_SECS", 2),
            burst_bytes: var("BURST_BYTES", 65_536usize),
            allow_private_sources: var("ALLOW_PRIVATE_SOURCES", false),
            user_agent: var("UPSTREAM_USER_AGENT", "RadioGateway/1.0".to_string()),
            station_fail_rounds: var("STATION_FAIL_ROUNDS", 3u32).max(1),
            station_retry: secs("STATION_RETRY_SECS", 30),
            control_dir: opt("CONTROL_DIR"),
            disk_path: var("DISK_PATH", "/".to_string()),
        }
    }
}
