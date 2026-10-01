// Resource headroom per streaming server, from the figures each engine
// reports with its heartbeat (Redis hash node:<NODE_ID>). A server's name in
// the Servers list must equal its engine's NODE_ID for the two to be matched.

const config = require('./config');
const db = require('./db');
const { redis } = require('./cache');
const haproxy = require('./haproxy');

const STALE_SECS = 30;
const RANK = { ok: 0, warning: 1, critical: 2 };

const percent = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : null);

function level(value) {
  if (value === null) return 'ok';
  if (value >= config.capacityCriticalPercent) return 'critical';
  if (value >= config.capacityWarningPercent) return 'warning';
  return 'ok';
}

const worst = (levels) => levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');

// Turns one engine's raw heartbeat into the public shape; null if it is missing or stale.
function resources(hash, nowSecs = Math.floor(Date.now() / 1000)) {
  if (!hash || !hash.reported_at || nowSecs - Number(hash.reported_at) > STALE_SECS) return null;
  const num = (key) => Number(hash[key]) || 0;
  const memoryUsed = Math.max(0, num('memory_total') - num('memory_available'));
  const diskUsed = Math.max(0, num('disk_total') - num('disk_free'));
  const cpu = { percent: num('cpu_percent'), cores: num('cpu_cores'), load_1m: num('load_1m') };
  const memory = { total_bytes: num('memory_total'), used_bytes: memoryUsed, percent: percent(memoryUsed, num('memory_total')) };
  const disk = { total_bytes: num('disk_total'), used_bytes: diskUsed, free_bytes: num('disk_free'), percent: percent(diskUsed, num('disk_total')) };
  cpu.status = level(cpu.percent);
  memory.status = level(memory.percent);
  disk.status = level(disk.percent);
  return {
    status: worst([cpu.status, memory.status, disk.status]),
    cpu,
    memory,
    disk,
    network_out_bps: num('network_out_bps'),
    listeners: num('listeners'),
    stations_on_air: num('stations'),
    uptime_seconds: Math.max(0, nowSecs - num('started_at')),
    engine_version: hash.version || null,
    reported_at: new Date(Number(hash.reported_at) * 1000).toISOString(),
  };
}

// Whether the engine can deliver audio, as it reports itself. null if it is not reporting.
function audioState(hash, row, nowSecs = Math.floor(Date.now() / 1000)) {
  const reporting = hash && hash.reported_at && nowSecs - Number(hash.reported_at) <= STALE_SECS;
  if (reporting && hash.audio === 'no_audio') {
    return {
      status: 'no_audio',
      reason: hash.audio_reason || null,
      since: hash.audio_since ? new Date(Number(hash.audio_since) * 1000).toISOString() : null,
      forced: hash.audio_forced === 'true',
    };
  }
  // Forced but not picked up yet (or the engine is silent): show the intent.
  if (row && row.audio_override) return { status: 'no_audio', reason: row.audio_override, since: null, forced: true };
  return reporting ? { status: 'ok', reason: null, since: null, forced: false } : null;
}

// Decides whether the cluster as a whole needs another server. Only servers
// that are enabled and reporting count towards the averages.
function assess(servers) {
  const active = servers.filter((s) => s.enabled && s.resources);
  const reasons = [];
  let addServer = false;

  for (const server of active) {
    const { cpu, memory, disk } = server.resources;
    if (cpu.status !== 'ok') reasons.push(`${server.name}: CPU at ${cpu.percent}%`);
    if (memory.status !== 'ok') reasons.push(`${server.name}: memory at ${memory.percent}%`);
    if (disk.status !== 'ok') reasons.push(`${server.name}: disk at ${disk.percent}% (free up space or enlarge the disk)`);
    if (cpu.status === 'critical' || memory.status === 'critical') addServer = true;
  }
  const average = (pick) => (active.length ? active.reduce((sum, s) => sum + pick(s.resources), 0) / active.length : 0);
  const avgCpu = Math.round(average((r) => r.cpu.percent) * 10) / 10;
  const avgMemory = Math.round(average((r) => r.memory.percent || 0) * 10) / 10;
  if (avgCpu >= config.capacityWarningPercent) {
    addServer = true;
    reasons.push(`average CPU across servers is ${avgCpu}%`);
  }
  if (avgMemory >= config.capacityWarningPercent) {
    addServer = true;
    reasons.push(`average memory across servers is ${avgMemory}%`);
  }
  for (const server of servers.filter((s) => s.audio && s.audio.status === 'no_audio')) {
    reasons.push(`${server.name}: no audio${server.audio.forced ? ' (set by an administrator)' : ''}${server.audio.reason ? `: ${server.audio.reason}` : ''}`);
  }
  for (const server of servers.filter((s) => s.enabled && !s.resources)) {
    reasons.push(`${server.name}: not reporting (engine down, or its NODE_ID differs from the server name)`);
  }

  return {
    status: worst([...active.map((s) => s.resources.status), ...(servers.some((s) => s.audio && s.audio.status === 'no_audio') ? ['warning'] : [])]),
    add_server_recommended: addServer,
    reasons,
    averages: { cpu_percent: avgCpu, memory_percent: avgMemory },
  };
}

// Server rows with their live state. A proxied server's state and connection
// count come from this gateway's HAProxy; a direct server is outside it, so
// its own engine's heartbeat is the evidence that it is up.
async function describe(rows) {
  const [status, hashes] = await Promise.all([
    haproxy.status(),
    Promise.all(rows.map((row) => redis.hGetAll(`node:${row.name}`))),
  ]);
  return rows.map((row, i) => {
    const seen = status.get(haproxy.serverName(row));
    const res = resources(hashes[i]);
    const direct = row.mode === 'direct';
    return {
      id: row.id,
      name: row.name,
      mode: row.mode,
      host: row.host,
      port: row.port,
      weight: row.weight,
      enabled: row.enabled,
      is_builtin: row.is_builtin,
      state: direct ? (res ? 'UP' : 'DOWN') : seen ? seen.state : null,
      connections: direct ? (res ? res.listeners : null) : seen ? seen.connections : null,
      audio: audioState(hashes[i], row),
      resources: res,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

async function report() {
  const [{ rows }, size] = await Promise.all([
    db.query('SELECT * FROM engine_nodes ORDER BY is_builtin DESC, name'),
    db.query('SELECT pg_database_size(current_database())::bigint AS bytes'),
  ]);
  const servers = await describe(rows);
  const reporting = servers.filter((s) => s.resources);
  return {
    ...assess(servers),
    thresholds: { warning_percent: config.capacityWarningPercent, critical_percent: config.capacityCriticalPercent },
    totals: {
      servers: servers.length,
      servers_reporting: reporting.length,
      listeners: reporting.reduce((sum, s) => sum + s.resources.listeners, 0),
      network_out_bps: reporting.reduce((sum, s) => sum + s.resources.network_out_bps, 0),
    },
    database: { size_bytes: size.rows[0].bytes },
    servers,
  };
}

module.exports = { report, describe, resources, assess, audioState };
