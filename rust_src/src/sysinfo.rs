//! Host resource figures (CPU, memory, disk, outbound traffic) reported with
//! each heartbeat, so the operator can see when a server is running out of room.
//!
//! Read straight from /proc, which inside a container still describes the
//! host for CPU and memory. Disk is the filesystem holding `DISK_PATH`.

use std::{ffi::CString, fs, time::Instant};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Snapshot {
    pub cpu_percent: f64,
    pub cpu_cores: u64,
    pub load_1m: f64,
    pub memory_total: u64,
    pub memory_available: u64,
    pub disk_total: u64,
    pub disk_free: u64,
    /// Bytes per second leaving this engine's network interfaces.
    pub network_out_bps: u64,
    /// What this engine process itself uses: processor time as a percentage
    /// of one core (so it can exceed 100), and resident memory in bytes. With
    /// the listener count, this gives the cost of one listener on this server.
    pub engine_cpu_percent: f64,
    pub engine_memory: u64,
}

pub struct Sampler {
    disk_path: String,
    cpu: Option<(u64, u64)>,
    net: Option<(u64, Instant)>,
    process: Option<(u64, Instant)>,
}

/// `(busy, total)` jiffies from the aggregate `cpu` line of /proc/stat.
fn parse_cpu(stat: &str) -> Option<(u64, u64)> {
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let fields: Vec<u64> = line.split_whitespace().skip(1).take(8).filter_map(|v| v.parse().ok()).collect();
    if fields.len() < 5 {
        return None;
    }
    let total: u64 = fields.iter().sum();
    let idle = fields[3] + fields[4];
    Some((total - idle, total))
}

fn parse_meminfo(meminfo: &str, key: &str) -> u64 {
    meminfo
        .lines()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix(':'))
        .and_then(|rest| rest.split_whitespace().next()?.parse::<u64>().ok())
        .map_or(0, |kb| kb * 1024)
}

/// Total bytes transmitted on every interface except loopback.
fn parse_net_tx(dev: &str) -> u64 {
    dev.lines()
        .filter_map(|l| l.split_once(':'))
        .filter(|(name, _)| name.trim() != "lo")
        .filter_map(|(_, rest)| rest.split_whitespace().nth(8)?.parse::<u64>().ok())
        .sum()
}

/// Processor time this process has used, in clock ticks: user plus system
/// time, the 14th and 15th fields of /proc/self/stat. The second field is the
/// program's name in brackets and may itself contain spaces.
fn parse_process_ticks(stat: &str) -> Option<u64> {
    let mut fields = stat.rsplit_once(')')?.1.split_whitespace().skip(11);
    Some(fields.next()?.parse::<u64>().ok()? + fields.next()?.parse::<u64>().ok()?)
}

fn disk(path: &str) -> (u64, u64) {
    let Ok(path) = CString::new(path) else { return (0, 0) };
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is a valid NUL-terminated string and `stat` is a properly
    // sized, writable statvfs struct that the call fills in.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return (0, 0);
    }
    let unit = stat.f_frsize as u64;
    (stat.f_blocks as u64 * unit, stat.f_bavail as u64 * unit)
}

impl Sampler {
    pub fn new(disk_path: String) -> Self {
        Self { disk_path, cpu: None, net: None, process: None }
    }

    pub fn sample(&mut self) -> Snapshot {
        let read = |path: &str| fs::read_to_string(path).unwrap_or_default();
        let stat = read("/proc/stat");
        let meminfo = read("/proc/meminfo");

        let mut snapshot = Snapshot {
            cpu_cores: stat.lines().filter(|l| l.starts_with("cpu") && !l.starts_with("cpu ")).count() as u64,
            load_1m: read("/proc/loadavg").split_whitespace().next().and_then(|v| v.parse().ok()).unwrap_or(0.0),
            memory_total: parse_meminfo(&meminfo, "MemTotal"),
            memory_available: parse_meminfo(&meminfo, "MemAvailable"),
            ..Snapshot::default()
        };
        (snapshot.disk_total, snapshot.disk_free) = disk(&self.disk_path);

        if let Some((busy, total)) = parse_cpu(&stat) {
            if let Some((prev_busy, prev_total)) = self.cpu {
                let span = total.saturating_sub(prev_total);
                if span > 0 {
                    snapshot.cpu_percent = (busy.saturating_sub(prev_busy) as f64 / span as f64 * 100.0).clamp(0.0, 100.0);
                }
            }
            self.cpu = Some((busy, total));
        }

        let tx = parse_net_tx(&read("/proc/net/dev"));
        let now = Instant::now();
        if let Some((prev_tx, at)) = self.net {
            let secs = now.duration_since(at).as_secs_f64();
            if secs > 0.0 {
                snapshot.network_out_bps = (tx.saturating_sub(prev_tx) as f64 / secs) as u64;
            }
        }
        self.net = Some((tx, now));

        if let Some(ticks) = parse_process_ticks(&read("/proc/self/stat")) {
            if let Some((prev_ticks, at)) = self.process {
                let secs = now.duration_since(at).as_secs_f64();
                // SAFETY: sysconf only reads a system constant.
                let per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as f64;
                if secs > 0.0 {
                    snapshot.engine_cpu_percent = ticks.saturating_sub(prev_ticks) as f64 / per_second / secs * 100.0;
                }
            }
            self.process = Some((ticks, now));
        }
        // SAFETY: as above.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(1) as u64;
        snapshot.engine_memory = read("/proc/self/statm").split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) * page;
        snapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_line_splits_busy_from_idle() {
        let stat = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\n";
        assert_eq!(parse_cpu(stat), Some((150, 1000)));
        assert_eq!(parse_cpu("intr 1 2 3"), None);
    }

    #[test]
    fn process_time_is_read_past_a_name_with_spaces() {
        let stat = "4242 (stream node) S 1 4242 4242 0 -1 4194304 500 0 0 0 1234 766 0 0 20 0 9 0 100 1000 200";
        assert_eq!(parse_process_ticks(stat), Some(2000));
        assert_eq!(parse_process_ticks("garbage"), None);
    }

    #[test]
    fn the_engine_measures_itself() {
        let mut sampler = Sampler::new("/".into());
        sampler.sample();
        let mut spin = 0u64;
        for i in 0..20_000_000u64 {
            spin = spin.wrapping_add(i * i);
        }
        assert!(spin > 0);
        let second = sampler.sample();
        assert!(second.engine_memory > 1024 * 1024, "resident memory is at least a megabyte");
        assert!(second.engine_cpu_percent >= 0.0);
    }

    #[test]
    fn meminfo_values_are_bytes() {
        let meminfo = "MemTotal:       16208000 kB\nMemFree:          100 kB\nMemAvailable:    8104000 kB\n";
        assert_eq!(parse_meminfo(meminfo, "MemTotal"), 16_208_000 * 1024);
        assert_eq!(parse_meminfo(meminfo, "MemAvailable"), 8_104_000 * 1024);
        assert_eq!(parse_meminfo(meminfo, "Missing"), 0);
    }

    #[test]
    fn network_total_skips_loopback() {
        let dev = "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 10 1 0 0 0 0 0 0 5000 1 0 0 0 0 0 0\n  eth1: 10 1 0 0 0 0 0 0 250 1 0 0 0 0 0 0\n";
        assert_eq!(parse_net_tx(dev), 5250);
    }

    #[test]
    fn sampling_this_machine_gives_plausible_numbers() {
        let mut sampler = Sampler::new("/".to_string());
        let first = sampler.sample();
        assert!(first.cpu_cores >= 1);
        assert!(first.memory_total > first.memory_available);
        assert!(first.disk_total >= first.disk_free && first.disk_total > 0);
        let second = sampler.sample();
        assert!((0.0..=100.0).contains(&second.cpu_percent));
    }
}
