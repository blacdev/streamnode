// Keeps HAProxy's streaming backend in step with the engine_nodes table, using
// HAProxy's runtime API. The backend has no servers in its configuration file:
// every engine, including one on this same machine, is added here. Servers
// added this way live in HAProxy's memory, so the list is re-applied on a
// timer: after an HAProxy restart they are back within one sync interval.

const dns = require('dns').promises;
const net = require('net');
const config = require('./config');
const db = require('./db');

const BUILTIN_SERVER = 'local';
const serverName = (node) => (node.is_builtin ? BUILTIN_SERVER : `node${node.id}`);
const enabled = () => Boolean(config.haproxyAdmin);

// One command per connection: HAProxy answers and closes.
function command(text) {
  return new Promise((resolve, reject) => {
    const [host, port] = config.haproxyAdmin.split(':');
    const socket = net.createConnection({ host, port: Number(port) || 9999 });
    let out = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('HAProxy runtime API timed out')));
    socket.on('connect', () => socket.write(`${text}\n`));
    socket.on('data', (chunk) => { out += chunk; });
    socket.on('end', () => resolve(out.trim()));
    socket.on('error', reject);
  });
}

// Parses HAProxy's header-plus-rows output ("# a b c" or "# a,b,c").
function table(output, separator) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const headerAt = lines.findIndex((l) => l.startsWith('#'));
  if (headerAt < 0) return [];
  const columns = lines[headerAt].replace(/^#\s*/, '').split(separator);
  return lines.slice(headerAt + 1).map((line) => {
    const cells = line.split(separator);
    return Object.fromEntries(columns.map((name, i) => [name, cells[i]]));
  });
}

async function currentServers() {
  const rows = table(await command(`show servers state ${config.haproxyBackend}`), ' ');
  return new Map(rows.map((r) => [r.srv_name, { addr: r.srv_addr, port: Number(r.srv_port), weight: Number(r.srv_uweight), admin: Number(r.srv_admin_state) }]));
}

// HAProxy admin-state bits: 0x01 forced maintenance, 0x08 forced drain.
const isMaint = (s) => (s.admin & 0x01) !== 0;
const isDrain = (s) => (s.admin & 0x08) !== 0;

async function resolve(host) {
  if (net.isIP(host)) return host;
  return (await dns.lookup(host, { family: 4 })).address;
}

async function removeServer(name) {
  const path = `${config.haproxyBackend}/${name}`;
  await command(`set server ${path} state maint`);
  // A server can only be deleted once idle; its listeners reconnect elsewhere.
  await command(`shutdown sessions server ${path}`);
  const out = await command(`del server ${path}`);
  if (out && !/deleted/i.test(out)) throw new Error(`could not remove ${name}: ${out}`);
}

let lastError = null;

async function sync() {
  if (!enabled()) return;
  try {
    // Direct servers have their own HAProxy and public address; this one must not route to them.
    const { rows: nodes } = await db.query("SELECT * FROM engine_nodes WHERE mode = 'proxied' ORDER BY id");
    const current = await currentServers();
    const wanted = new Set(nodes.map(serverName));

    for (const [name] of current) {
      if (!wanted.has(name)) await removeServer(name);
    }

    for (const node of nodes) {
      const name = serverName(node);
      const path = `${config.haproxyBackend}/${name}`;
      let server = current.get(name);

      let address;
      try {
        address = await resolve(node.host);
      } catch {
        console.error(`[haproxy] cannot resolve ${node.host} for server "${node.name}"`);
        continue;
      }
      // A changed address (a container restart, a moved server) means re-adding it.
      if (server && (server.addr !== address || server.port !== node.port)) {
        await removeServer(name);
        server = null;
      }
      if (!server) {
        const out = await command(`add server ${path} ${address}:${node.port} check inter 3s fall 3 rise 2 weight ${node.weight}`);
        if (!/registered/i.test(out)) throw new Error(`could not add ${node.name}: ${out}`);
        await command(`enable health ${path}`);
        server = { weight: node.weight, admin: 0x01 };
      }

      if (server.weight !== node.weight) await command(`set server ${path} weight ${node.weight}`);
      if (node.enabled && (isMaint(server) || isDrain(server))) await command(`set server ${path} state ready`);
      if (!node.enabled && !isDrain(server)) await command(`set server ${path} state drain`);
    }
    if (lastError) console.log('[haproxy] server list is in sync again');
    lastError = null;
  } catch (err) {
    // Logged once per distinct failure so an absent HAProxy does not flood the log.
    if (err.message !== lastError) console.error('[haproxy] sync failed:', err.message);
    lastError = err.message;
    throw err;
  }
}

// Health and current listener connections per server, as HAProxy sees them.
async function status() {
  if (!enabled()) return new Map();
  try {
    const rows = table(await command('show stat'), ',').filter((r) => r.pxname === config.haproxyBackend);
    return new Map(rows.map((r) => [r.svname, { state: (r.status || '').split(' ')[0], connections: Number(r.scur) || 0 }]));
  } catch {
    return new Map();
  }
}

module.exports = { sync, status, serverName, enabled };
