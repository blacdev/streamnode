// What a listener costs, and what the installation can carry.
//
// Every listener takes some processor time and memory on the engine that
// serves them, and, unless that engine is an edge server with its own address,
// the same again on the master, whose HAProxy every listener's audio passes
// through. Those per-listener costs are measured here from the running
// servers and kept as a slowly moving average; until a server has carried
// enough listeners to measure, stated defaults are used and marked as such.
// Everything else (capacity, the "what if I add a server" calculator, prices)
// is arithmetic on those costs.

const config = require('./config');
const settings = require('./settings');

const MB = 1024 * 1024;
// Too few listeners and the figures are noise.
const MIN_LISTENERS = 25;
// Memory an engine uses with nobody connected.
const ENGINE_BASE_BYTES = 22 * MB;
// Protocol overhead on top of the audio bitrate.
const OVERHEAD = 1.07;

const DEFAULTS = Object.freeze({
  // Measured on the engine alone: about 10% of a core and 25 KB per 1,000 listeners... per listener.
  engine_core_per_listener: 0.0001,
  engine_bytes_per_listener: 25 * 1024,
  // Not yet measured anywhere: assumed equal to the engine's until a master has carried listeners.
  proxy_core_per_listener: 0.0001,
  proxy_bytes_per_listener: 40 * 1024,
  engine_samples: 0,
  proxy_samples: 0,
});

async function model() {
  return { ...DEFAULTS, ...((await settings.get('cost_model')) || {}) };
}

// A slowly moving average: each sample moves the figure by at most a fiftieth.
const blend = (old, value, samples) => old + (value - old) / Math.min(samples + 1, 50);

/**
 * Takes one reading of the running servers (`servers` as capacity.describe
 * returns them, `proxy` as haproxy.info returns it) and folds it into the model.
 */
async function learn(servers, proxy) {
  const current = await model();
  const next = { ...current };
  for (const server of servers) {
    const res = server.resources;
    if (!res || !res.engine || res.listeners < MIN_LISTENERS) continue;
    const core = res.engine.cpu_percent / 100 / res.listeners;
    const bytes = Math.max(0, res.engine.memory_bytes - ENGINE_BASE_BYTES) / res.listeners;
    if (!(core > 0) || core > 0.01) continue;
    next.engine_core_per_listener = blend(next.engine_core_per_listener, core, next.engine_samples);
    next.engine_bytes_per_listener = blend(next.engine_bytes_per_listener, bytes, next.engine_samples);
    next.engine_samples += 1;
  }
  if (proxy && proxy.connections >= MIN_LISTENERS) {
    const core = proxy.cores_used / proxy.connections;
    if (core > 0 && core <= 0.01) {
      next.proxy_core_per_listener = blend(next.proxy_core_per_listener, core, next.proxy_samples);
      if (proxy.memory_bytes > 0) next.proxy_bytes_per_listener = blend(next.proxy_bytes_per_listener, proxy.memory_bytes / proxy.connections, next.proxy_samples);
      next.proxy_samples += 1;
    }
  }
  if (next.engine_samples !== current.engine_samples || next.proxy_samples !== current.proxy_samples) {
    await settings.set({ cost_model: { ...next, updated_at: new Date().toISOString() } });
  }
  return next;
}

// How the model is shown: the figures, and whether each was measured here.
function describeModel(m) {
  return {
    engine: {
      percent_of_core_per_1000_listeners: Math.round(m.engine_core_per_listener * 1000 * 100 * 10) / 10,
      kilobytes_per_listener: Math.round(m.engine_bytes_per_listener / 1024),
      measured: m.engine_samples > 0,
      samples: m.engine_samples,
    },
    proxy: {
      percent_of_core_per_1000_listeners: Math.round(m.proxy_core_per_listener * 1000 * 100 * 10) / 10,
      kilobytes_per_listener: Math.round(m.proxy_bytes_per_listener / 1024),
      measured: m.proxy_samples > 0,
      samples: m.proxy_samples,
    },
    updated_at: m.updated_at || null,
  };
}

const kbpsPerListener = (bitrate) => bitrate * OVERHEAD;
const headroom = () => config.capacityWarningPercent / 100;

/**
 * How many listeners one machine can serve, and what stops it there.
 * `shares` says which costs fall on it: the engine's, the proxy's, or both.
 */
function machineCapacity(machine, bitrate, m, { engine = true, proxy = false } = {}) {
  const core = (engine ? m.engine_core_per_listener : 0) + (proxy ? m.proxy_core_per_listener : 0);
  const bytes = (engine ? m.engine_bytes_per_listener : 0) + (proxy ? m.proxy_bytes_per_listener : 0);
  const limits = {
    processor: core > 0 ? (machine.cores * headroom()) / core : Infinity,
    // A gigabyte is kept back for the system and the other services.
    memory: bytes > 0 ? Math.max(0, machine.memory_bytes * headroom() - 1024 * MB) / bytes : Infinity,
    network: (machine.port_mbps * 1000 * headroom()) / kbpsPerListener(bitrate),
  };
  const [limited_by, listeners] = Object.entries(limits).sort((a, b) => a[1] - b[1])[0];
  return { listeners: Math.floor(listeners), limited_by, limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Number.isFinite(v) ? Math.floor(v) : null])) };
}

/**
 * What a whole installation can carry at one bitrate.
 *
 * `master` is the machine running HAProxy ({cores, memory_bytes, port_mbps}),
 * `engines` the streaming servers ({name, mode, builtin, cores, memory_bytes,
 * port_mbps, weight}). A proxied engine's listeners all pass through the
 * master, so the master's processor and port cap their sum; a direct (edge)
 * server answers listeners itself and is limited only by its own machine.
 */
function clusterCapacity(master, engines, bitrate, m) {
  const proxied = engines.filter((e) => e.mode !== 'direct');
  const direct = engines.filter((e) => e.mode === 'direct');
  const perServer = {};

  // Slaves first: their listeners cost the master only the proxying.
  let slaves = 0;
  for (const engine of proxied.filter((e) => !e.builtin)) {
    perServer[engine.name] = machineCapacity(engine, bitrate, m);
    slaves += perServer[engine.name].listeners;
  }
  const masterCores = master.cores * headroom();
  const masterPort = (master.port_mbps * 1000 * headroom()) / kbpsPerListener(bitrate);
  const byProxyCpu = masterCores / m.proxy_core_per_listener;
  const throughMaster = Math.min(masterPort, byProxyCpu);
  const slavesServed = Math.min(slaves, throughMaster);

  // The engine on the master itself takes what processor the proxying leaves.
  let local = 0;
  const builtin = proxied.find((e) => e.builtin);
  if (builtin) {
    const coresLeft = Math.max(0, masterCores - slavesServed * m.proxy_core_per_listener);
    local = Math.max(0, Math.min(
      coresLeft / (m.proxy_core_per_listener + m.engine_core_per_listener),
      masterPort - slavesServed,
      machineCapacity(builtin, bitrate, m, { engine: true, proxy: true }).limits.memory ?? Infinity
    ));
    perServer[builtin.name] = { listeners: Math.floor(local), limited_by: 'shared with the proxy' };
  }
  const viaMaster = Math.floor(slavesServed + local);

  let own = 0;
  for (const engine of direct) {
    perServer[engine.name] = machineCapacity(engine, bitrate, m, { engine: true, proxy: true });
    own += perServer[engine.name].listeners;
  }

  let limited_by = 'the streaming servers';
  if (proxied.length && viaMaster >= Math.floor(masterPort) - 1) limited_by = "the master's network port";
  else if (proxied.length && slavesServed + local >= byProxyCpu - 1) limited_by = "the master's processor";
  else if (builtin && !slaves) limited_by = "the master's processor";
  return { listeners: viaMaster + own, through_master: viaMaster, direct: own, limited_by, servers: perServer };
}

// How listeners spread over the servers: in proportion to weight behind the
// master, with each edge server taking an equal share of the domain's DNS answers.
function spread(listeners, engines) {
  const proxied = engines.filter((e) => e.mode !== 'direct' && e.enabled !== false);
  const direct = engines.filter((e) => e.mode === 'direct' && e.enabled !== false);
  const addresses = direct.length + (proxied.length ? 1 : 0);
  if (!addresses) return {};
  const perAddress = listeners / addresses;
  const out = {};
  const weights = proxied.reduce((sum, e) => sum + (e.weight || 100), 0);
  for (const engine of proxied) out[engine.name] = (perAddress * (engine.weight || 100)) / weights;
  for (const engine of direct) out[engine.name] = perAddress;
  return out;
}

/**
 * "What if I add this server?" `candidate` is {vcpus, memory_gb, port_mbps,
 * mode}. Returns capacity and the spread of the present load, before and
 * after, with plain statements of what changes.
 */
function estimate({ master, engines, listeners, bitrate, candidate }, m) {
  const added = {
    name: 'new server', mode: candidate.mode, builtin: false, weight: 100, enabled: true,
    cores: candidate.vcpus, memory_bytes: candidate.memory_gb * 1024 * MB, port_mbps: candidate.port_mbps,
  };
  const before = clusterCapacity(master, engines, bitrate, m);
  const after = clusterCapacity(master, [...engines, added], bitrate, m);
  const own = machineCapacity(added, bitrate, m, { engine: true, proxy: candidate.mode === 'direct' });

  const load = (set) => {
    const share = spread(listeners, set);
    const viaMaster = set.filter((e) => e.mode !== 'direct').reduce((sum, e) => sum + (share[e.name] || 0), 0);
    const local = set.find((e) => e.builtin && e.mode !== 'direct');
    const masterCores = viaMaster * m.proxy_core_per_listener + (local ? (share[local.name] || 0) * m.engine_core_per_listener : 0);
    return {
      servers: Object.fromEntries(set.map((e) => [e.name, {
        listeners: Math.round(share[e.name] || 0),
        processor_percent: e.builtin ? null : Math.round((((share[e.name] || 0) * (m.engine_core_per_listener + (e.mode === 'direct' ? m.proxy_core_per_listener : 0))) / e.cores) * 1000) / 10,
      }])),
      master: {
        listeners_through_it: Math.round(viaMaster),
        processor_percent: Math.round((masterCores / master.cores) * 1000) / 10,
        traffic_mbps: Math.round((viaMaster * kbpsPerListener(bitrate)) / 100) / 10,
        port_percent: Math.round(((viaMaster * kbpsPerListener(bitrate)) / 1000 / master.port_mbps) * 1000) / 10,
      },
    };
  };
  const loadBefore = load(engines);
  const loadAfter = load([...engines, added]);

  const notes = [];
  const gain = after.listeners - before.listeners;
  notes.push(`On its own this server can serve about ${own.listeners.toLocaleString('en')} listeners at ${bitrate} kbps; its ${own.limited_by} is what stops it there.`);
  notes.push(gain > 0
    ? `The installation's capacity goes from about ${before.listeners.toLocaleString('en')} to ${after.listeners.toLocaleString('en')} listeners (${gain.toLocaleString('en')} more).`
    : `The installation's capacity stays at about ${before.listeners.toLocaleString('en')} listeners: it is held by ${before.limited_by}, which this server does not relieve.`);
  if (candidate.mode === 'direct') {
    notes.push(`As an edge server with its own DNS record it answers listeners itself. Of today's ${listeners.toLocaleString('en')} listeners about ${loadAfter.servers['new server'].listeners.toLocaleString('en')} would go to it, and the master's traffic falls from ${loadBefore.master.traffic_mbps} to ${loadAfter.master.traffic_mbps} Mbit/s.`);
  } else {
    notes.push(`As a slave it takes over engine work, not traffic: every listener's audio still passes through the master, whose traffic stays at ${loadAfter.master.traffic_mbps} Mbit/s while its processor use goes from ${loadBefore.master.processor_percent}% to ${loadAfter.master.processor_percent}%.`);
    if (after.limited_by !== 'the streaming servers') notes.push(`After adding it the limit is ${after.limited_by}. Past that point, more slaves do not help: add an edge server, which carries its own traffic, or a larger port or processor on the master.`);
  }
  return {
    bitrate_kbps: bitrate,
    listeners_now: listeners,
    new_server: { ...candidate, capacity: own },
    capacity: { before, after, gained: gain },
    load_now: { before: loadBefore, after: loadAfter },
    notes,
  };
}

module.exports = { model, learn, describeModel, machineCapacity, clusterCapacity, spread, estimate, kbpsPerListener, DEFAULTS, MB };
