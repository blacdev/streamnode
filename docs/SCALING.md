# Adding servers

When one server is no longer enough, add **slave nodes**. A slave node runs only the
audio engine. The master's HAProxy starts sending it listeners as soon as it joins,
and the domain listeners use never changes.

## Knowing when to add one

The **Servers** tab shows CPU, memory, disk and outbound traffic for each server and
raises a notice when capacity is running low. The same information comes from
`GET /api/v1/capacity`, including an `add_server_recommended` flag
(see the [API guide](API.md#capacity-is-another-server-needed)).

## How it works

```
                listeners  ->  stream.example.com
                                     |
                              +-------------+
                              |   MASTER    |  HAProxy: least-connections balancing
                              +-------------+
                               /     |     \
                       +-------+ +-------+ +-------+
                       | local | | edge-2| | edge-3|   engines
                       +-------+ +-------+ +-------+
                         (on the master,     (slave nodes)
                          role "both")
```

- **Balancing.** Each new listener goes to the engine with the fewest listeners, in
  proportion to its **weight**. A server with weight 200 takes twice the listeners of
  one with 100.
- **Health.** HAProxy checks every engine every 3 seconds. One that stops answering
  receives no new listeners until it recovers; its listeners reconnect and land on
  another server.
- **Shared state.** Every engine uses the master's Redis, so they all know the same
  stations and their counters add up. Listener counts, history, usage and listener
  limits cover all servers together.
- **Statistics stay on the master.** They are saved in the master's database however
  many slave nodes there are.

### What moves to a slave node and what stays

| | Master | Slave node |
|---|---|---|
| Relaying audio, connections to station sources | Only in role `both` | Yes |
| Engine CPU and memory | Only in role `both` | Yes |
| HAProxy: every listener connection | Yes | No |
| Bandwidth | **All of it passes through the master** | Its share, from the master |
| Dashboard, API, statistics, accounts | Yes | No |

Adding slave nodes takes the engine work off the master. A master in role `master`
relays nothing itself, so its memory use is HAProxy's (a few tens of kilobytes per
listener) plus the dashboard and databases. What does not move is the network path:
all audio still flows out through the master, so the master's link must carry the
whole audience. If that link becomes the limit, see
[Edge servers](#edge-servers-optional) below.

### Effect on a station's own server

Each engine that has listeners for a station opens its own connection to that
station's source. With three engines a station sees at most three connections instead
of one: still independent of audience size.

## Adding a slave node

Prerequisites, once, on the master:

- Port **6380** open to the new server (Redis, over TLS).
- On a `both` install: `CLUSTER_BIND=0.0.0.0` in `.env`, then `docker compose up -d`.
  A `master` install has this already.
- A real certificate, or be ready to pass `--insecure` on the slave.

Then, either way:

### Option 1: one command

On the master:

```bash
./scripts/add-server.sh
```

(or dashboard: **Servers > Add server > Create install command**, or
`POST /api/v1/cluster/join-tokens`). Run the printed command on the new server, in a
copy of this project:

```bash
./install.sh --role slave --master https://stream.example.com --token rgj_4be1a09c...
```

The slave installs the engine, presents the token to the master, receives its
credentials, and is added to HAProxy. Nothing else needs doing.

### Option 2: finish from the master

On the new server:

```bash
./install.sh --role slave
```

It prints its address, engine port and setup key. On the master's dashboard open
**Servers > Add server**, enter them and press **Connect server**, or:

```bash
curl -X POST https://stream.example.com/api/v1/servers \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"host": "203.0.113.20", "port": 3000, "setup_key": "rgn_..."}'
```

### After it joins

- It appears under **Servers** as **Healthy** within a few seconds and receives new
  listeners. Listeners already connected stay where they are, so the numbers even out
  as people come and go.
- Open TCP **3000** on the slave to the master only.
- If the two servers share a private network, install the slave with
  `--advertise <its private address>` so audio between them stays off the internet.

### What happens when a slave joins

1. The slave's engine sends its join token to `POST /api/v1/cluster/join` on the
   master, over HTTPS.
2. The master checks the token (valid, unexpired, unused, and from the expected
   address if it was issued for one), records the server, and adds it to HAProxy.
3. The master answers with the Redis port and password and the engine secret.
4. The engine saves these in its data volume, connects to Redis on the master
   (port 6380, TLS), and starts answering HAProxy's health checks.

A restarted slave reuses its saved enrolment; it needs a token only once.

## Managing servers

| Task | Dashboard | API |
|---|---|---|
| See state, listeners and resource use | Servers tab | `GET /servers`, `GET /capacity` |
| Send a server more or fewer listeners | Weight | `PATCH /servers/{id}` `{"weight": 200}` |
| Stop new listeners, keep current ones | Drain | `PATCH /servers/{id}` `{"enabled": false}` |
| Put it back | Enable | `PATCH /servers/{id}` `{"enabled": true}` |
| Remove a server | Remove | `DELETE /servers/{id}` |

Removing a server disconnects its listeners at once; their players reconnect to the
remaining servers. Drain first if you would rather let them finish. After removing a
slave, stop it (`docker compose down -v` on that server). To be certain a removed
server can no longer use its credentials, rotate them:
[Operations](OPERATIONS.md#rotating-credentials).

The engine on the master itself (`local`, role `both`) cannot be removed from the
list, but it can be drained or given a lower weight. To stop running it altogether,
change the master's role: [Installation](INSTALLATION.md#changing-a-servers-role).

| State | Meaning |
|---|---|
| Healthy | Receiving listeners |
| Unreachable | The master's health check is failing; no new listeners are sent |
| Draining | Keeps current listeners, receives no new ones |
| Pending | Saved, not yet applied to HAProxy (applied within seconds) |
| No audio | The server gets no audio from any source, or was marked so by hand. No listeners are sent to it |
| Not reporting | Listed, but its engine is not sending resource figures |

### When there is no audio

The check is made **per station, on each server**. A server can be healthy and still
get no audio for one station: the station's encoder is off, or that one source is
unreachable from that one server.

**One station has no audio on a server.** After three failed attempts on its primary
and backup (a few seconds), that server:

1. lets go of that station's listeners, so their players reconnect;
2. stops the station's relay, freeing its connections and memory;
3. refuses that station for 30 seconds without touching the source, then tries again
   the next time a listener asks for it;
4. reports it, so the station shows **No audio on <server>** on the dashboard and in
   `live.no_audio_on` in the API, with the reason.

Every other station on that server carries on untouched, and the server stays in
service. A listener asking for the silent station is passed by HAProxy to another
server, which plays it if it can. If no server can, the station shows **Source
offline** and listeners get `502 Station source offline` straight away, with nothing
held open for it anywhere.

**A whole server has no audio.** If a server has no audio at all and is failing on
two or more stations that other servers are not failing on, the fault is the server's
(a broken route, a blocked address, DNS trouble on that machine). It then:

1. reports **No audio** on the Servers tab and in the API, with the reason;
2. fails its health check, so HAProxy stops sending it listeners for any station;
3. re-tests the sources every 10 seconds and returns to service by itself as soon as
   one works.

It never takes itself out if no other server is healthy, so a wide source outage
cannot empty the cluster.

**Setting it by hand.** Your own monitoring, or you, can take a whole server out the
same way:

| | Dashboard | API |
|---|---|---|
| Take a server out as having no audio | Mark no audio | `PUT /servers/{id}/audio-status` `{"status": "no_audio", "reason": "..."}` |
| Hand the decision back to the server | Back to automatic | `PUT /servers/{id}/audio-status` `{"status": "auto"}` |

A server marked by hand stays out until you send `auto`; it is not probed back in.

| | Drain | No audio |
|---|---|---|
| New listeners | None | None |
| Current listeners | Stay until they leave | Disconnected at once, reconnect elsewhere |
| Use it for | Planned maintenance | A server that is not delivering sound |

### Re-joining a slave

Run the install command again on the slave with a new token. Its old enrolment is
discarded and it joins afresh, keeping its name. Do this after rotating the master's
credentials, moving the master, or rebuilding the slave.

## Notes

- **Peak listeners** for a station spread over several servers is the sum of each
  server's peak within the minute. If they peaked at different moments in that minute,
  the figure can read slightly high.
- **Listener limits** are enforced across all servers. Listeners arriving on
  different servers in the same instant can overshoot by one or two.
- **If the master is down,** nothing is reachable: it is the entry point. Keep it
  healthy and backed up ([Operations](OPERATIONS.md#backups)). If only its database is
  down, audio continues and statistics queue until it returns.
- **After HAProxy restarts** on the master, it has no servers for a few seconds
  until the admin service re-adds them; listeners connecting in that moment get `503`
  and retry.

## Edge servers (optional)

A slave node relieves the master of everything except bandwidth. If the master's
network link is the limit, an **edge server** adds a second public entry point for
the *same* domain: it runs its own HAProxy and engine, and you add its address as a
second DNS A record. Listeners that DNS sends to it never touch the master.
Statistics, the dashboard and the API still live on the master.

| | Slave node | Edge server |
|---|---|---|
| Listeners reach it | Through the master's HAProxy | Directly, through its own DNS record |
| Relieves the master of | Engine CPU and memory | Also connections and bandwidth, for its share |
| Setup | One command | Manual: certificate copy, private relay link, DNS |
| A failed server | Skipped automatically | Receives its share until its DNS record is removed |
| Balancing | By listener count and weight | Even split by DNS |

Setting one up:

1. **On the master**, set `RELAY_BIND` in `.env` to the master's **private** address
   and run `docker compose up -d`. This publishes the relay port (8444) there; edge
   servers forward dashboard, API and certificate-validation requests to it. It must
   be reachable only from your edge servers. Also make sure `CLUSTER_BIND=0.0.0.0`.
2. **On the edge server**, copy the project, then in `edge/`:
   ```bash
   cp .env.example .env     # NODE_ID, REDIS_URL, ENGINE_SECRET, GATEWAY_PRIVATE_HOST, CERT_SOURCE
   ./sync-cert.sh           # copies the certificate from the master over SSH
   docker compose up --build -d
   ```
   `REDIS_URL` is `rediss://:<REDIS_PASSWORD>@<master domain>:6380`; `ENGINE_SECRET`
   is the master's. Add the cron line shown in `sync-cert.sh` so renewals reach it.
3. **Check it** before sending listeners:
   ```bash
   curl --resolve stream.example.com:443:203.0.113.20 https://stream.example.com/api/v1/health
   ```
4. **Register it** so it appears in the Servers list and capacity report:
   ```bash
   curl -X POST https://stream.example.com/api/v1/servers \
     -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"name": "edge-2", "host": "203.0.113.20", "mode": "direct"}'
   ```
5. **Add a second A record** for the domain pointing at it, with a short TTL (300
   seconds or less).

To take an edge server out, remove its A record, wait for the TTL and for its
listeners to leave, then stop it. If one fails, remove its record: DNS keeps handing
out its address until you do, though browsers and many players try the next address
by themselves. Weight and draining do not apply to edge servers.
