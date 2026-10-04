# Architecture

## Components

```
                         Internet
                            |
                   +-----------------+
   :80 / :443 ---> |     HAProxy     |  TLS termination, routing, API rate limit
                   +-----------------+
                     |             |
        /admin, /api |             | everything else (/<slug>)
                     v             v
          +----------------+   +----------------+        +------------------+
          |  Admin (Node)  |   |  Engine (Rust) | -----> | Station sources  |
          |  API, dashboard|   |  audio relay   |  one   | (Icecast,        |
          |  stats writer  |   |                |  conn  |  SHOUTcast, ...) |
          +----------------+   +----------------+  each  +------------------+
             |          |          |
             v          v          v
       +------------+  +--------------+
       | PostgreSQL |  |    Redis     |
       | permanent  |  | registry and |
       | records    |  | counters     |
       +------------+  +--------------+
```

On the master, all containers share one private Docker bridge network. Only HAProxy publishes
ports.

| Service | Role | State |
|---|---|---|
| `haproxy_edge` | Terminates TLS, sends `/admin` and `/api` to the admin service and everything else to an engine (local or on a slave node), rate-limits the API, carries Redis to slave nodes over TLS | None |
| `audio_engine` (role `both`) / `slave_engine` (slave nodes) | Relays audio. Reads station profiles from Redis, writes counters and live state to Redis | In memory only |
| `admin_dashboard` | REST API, dashboard, OpenAPI docs. Owns the database schema. Moves counters from Redis to PostgreSQL every minute | None |
| `postgres_db` | Accounts, stations, API keys, statistics, audit log | Volume `postgres_data` |
| `redis_cache` | Station registry for the engine, live state, counters awaiting persistence, sessions | Volume `redis_data` (append-only file) |

PostgreSQL is the source of truth. Redis can be wiped at any time: the admin service
republishes every station on start and every five minutes.

## The relay engine

### One relay per station

Each station with at least one listener has exactly one *relay*: a task holding one
connection to the source. Audio chunks are published into a broadcast channel; each
listener connection subscribes to it. Chunks are reference-counted, so a thousand
listeners share one copy of the audio in memory.

```
source --> relay task --> broadcast channel --+--> listener
                 |                            +--> listener
                 +--> burst buffer            +--> listener
```

**Lifecycle.** The first listener to request `/<slug>` creates the relay. When the
last listener leaves, the relay waits `IDLE_GRACE_SECS` (so a player reconnecting, or
the next listener, does not cause a reconnect to the source) and then disconnects
from the source and removes itself. Listener registration and relay removal take the
same lock, so a listener can never attach to a relay that is shutting down.

**Burst buffer.** The relay keeps the most recent `BURST_BYTES` of audio. A new
listener receives it immediately, which fills the player's buffer and starts playback
without a wait. The snapshot and the channel subscription are taken under one lock, so
the two join with no gap and no repeat.

**Slow listeners.** The channel holds 512 chunks. A listener that falls further behind
skips forward rather than making the gateway hold memory for it; audio players
resynchronise on the next frame.

### Failover

A source is considered connected only once it has delivered audio bytes, not merely
accepted a connection. From then on the relay treats three events as loss of source:
a read error, end of stream, and no data for `STALL_TIMEOUT_SECS`.

MP3 and AAC streams are cut into frames as they pass through, from their headers. That
gives the relay switches that land on frame boundaries, and the stream's format
(`format:<slug>` in Redis) for checking uploaded files against. Other formats are
relayed as opaque bytes.

Whether a stream is silent is found by decoding a sample of it (`detector.rs`, using
FFmpeg's MP3 and AAC decoders through the `ffmpeg-next` crate). Twice a second the
decoder is reset and given a short run of consecutive frames: enough lead-in for the
MP3 bit reservoir and the codecs' frame overlap, then two frames whose peak level is
measured against `SILENCE_THRESHOLD_DB`. The other nine tenths of the stream are never
decoded, which keeps the cost near 0.07% of a core per station. The decoded audio is
discarded; it also tells the engine whether an AAC stream is HE-AAC. If a stream
cannot be decoded, the frames' own marking of digital silence is used instead.

Only those two decoders are compiled, from FFmpeg's source, and linked into the engine
binary (`rust_src/build-ffmpeg.sh`), so the image stays small and the server needs no
FFmpeg installed.

| Situation | Behaviour |
|---|---|
| Primary fails on connect | Backup is tried immediately |
| The playing stream drops, stalls or goes silent | It is retried for the station's failover delay (6 s by default). If it returns, nothing else happens |
| Still no audio after the delay | The ident plays, then the next source: the backup stream, else the fallback file, looped and paced in real time |
| Running on the backup or the fallback file | Streams that are down are probed in the background every 2 s; one that has delivered a second of real audio is returned to at once: the ident first if the station has one, otherwise (MP3) a fade out and in made by lowering each frame's `global_gain`, with no decoding |
| Any join into an MP3 stream | Frames whose data begins before the join (the bit reservoir) are sent with empty side information, so players decode silence for about 26 ms each instead of noise |
| Nothing left to play | Sources are retried with backoff; after `STATION_FAIL_ROUNDS` the station is marked silent on that server and its listeners released |
| Both down, new listener | Hears the fallback file if there is one; otherwise receives `502` after the first failed round, or `504` if the attempt outlasts `READY_TIMEOUT_SECS` |

Idents and fallback files are fetched from the master
(`GET /api/v1/internal/files/{id}`, authenticated with the engine secret): the ident
into memory when the relay starts, the fallback file as a stream read about a second
ahead of what is played, so its size does not matter. A file whose format differs from
the stream's is skipped. See [Failover, idents and fallback audio](FAILOVER.md).

Listeners keep the response headers they received when they connected, so the backup
should use the same codec as the primary.

### Passthrough

The engine never transcodes or re-frames what it sends: listeners receive the source's
own bytes. (It decodes a sample of the stream only to measure its level.) The source's `Content-Type`
and its `icy-*` / `ice-audio-info` headers are forwarded as received.

The only bytes the engine handles specially are ICY in-stream metadata blocks. It
always asks the source for them, strips them out of the shared buffer (so the buffer
is pure audio), and re-inserts them per listener for players that send
`Icy-MetaData: 1`. Players that do not ask receive clean audio. This is what lets
metadata-aware and metadata-unaware players share one upstream connection.

### Source compatibility

- Standard HTTP and HTTPS sources (Icecast, SHOUTcast v2, most hosted providers),
  including redirects and chunked transfer encoding.
- SHOUTcast v1, which answers with a non-HTTP `ICY 200 OK` status line: when the
  normal client rejects the response, a minimal raw client retries.
- A source URL that points at an `.m3u` or `.pls` playlist is followed to the stream
  inside it.
- HLS and DASH are not supported, and are rejected with a clear error in the log.

### Title and artwork

Now-playing information has two possible origins:

1. **In-stream ICY titles** from the source (the default).
2. **The station's metadata URL**, polled every `METADATA_POLL_SECS` while the station
   has listeners. When it answers, it takes precedence. If it stops answering for
   three polls, in-stream titles are used again.

The result is delivered three ways: as ICY metadata to players that ask for it, in
the `live` object of the API, and on the public now-playing endpoint.

### Protection against internal requests

Station URLs are supplied by tenants, so the engine must not be usable to reach the
internal network. Every outbound connection is filtered: literal IP addresses are
checked, hostnames are resolved through a resolver that discards private, loopback,
link-local and reserved addresses, and each redirect hop is checked again. The check
happens at connection time, so a hostname that later changes to an internal address
is still blocked.

## Statistics pipeline

```
engine (every 2 s)           admin (every 60 s)                PostgreSQL
-------------------          ------------------------          ------------------
stats:bytes        hash  --> rename to flush:<ts>:...   -->   station_stats_minute
stats:sessions     hash      read, insert, delete             station_stats_daily
stats:listener_ms  hash
stats:peak:<node>  zset
live:<slug>:<node> hash (expires after 15 s)   --> read directly by the API
```

- **Counting.** Each relay keeps atomic counters in memory. Bytes are counted as they
  are handed to each listener's connection, so the figure is bytes sent to listeners,
  not bytes received from the source. A connection counts as a listener and as a
  session only once audio starts flowing to it.
- **Flushing to Redis.** Every two seconds the engine sends one pipeline for all
  relays. If Redis is unavailable the counters are put back and retried.
- **Persisting.** Once a minute the admin service atomically renames the accumulators
  aside (a Lua script), so the engine continues into fresh keys, then writes the
  snapshot to PostgreSQL in a single statement that also updates the daily rollup. The
  snapshot timestamp is the row key, which makes a retry after a crash idempotent. A
  snapshot is deleted from Redis only after the database has it; if PostgreSQL is down,
  snapshots queue in Redis and are written when it returns.
- **Retention.** Minute rows are kept for `STATS_MINUTE_RETENTION_DAYS` (default 90).
  Daily rows are kept permanently and are what billing reads.

| Metric | Meaning |
|---|---|
| `bytes` | Bytes sent to listeners |
| `peak_listeners` | Highest number of simultaneous listeners in the bucket |
| `avg_listeners` | Listener-seconds divided by the bucket length |
| `listener_hours` | Total listening time |
| `sessions` | Listener connections started |

## Data model

| Table | Purpose |
|---|---|
| `users` | Accounts. `role` is `admin` or `tenant`; `external_id` links to an outside system |
| `stations` | One row per relayed station, owned by a user |
| `api_keys` | SHA-256 hashes of API keys, with a display prefix |
| `station_stats_minute` | One row per station per flush while active |
| `station_stats_daily` | One row per station per UTC day, permanent |
| `media_files` | Uploaded idents and fallback files: owner, format, length, where the audio starts, where it is stored, and whether it is being or has been converted |
| `settings` | Gateway-wide settings changed while running (ident limit, default quota, Dropbox connection, rates, mail server, the learned cost of a listener) |
| `notifications` | One row per notice emailed, so that none is sent twice in its period |
| `engine_nodes` | Streaming servers HAProxy balances across |
| `join_tokens` | Hashes of one-time tokens for enrolling slave nodes |
| `audit_log` | Who changed what, from which address |
| `schema_migrations` | Applied migration files |

Schema changes are numbered SQL files in `admin_src/migrations/`. The admin service
applies any that are missing when it starts, inside a transaction and under an
advisory lock.

### Redis keys

| Key | Type | Written by | Purpose |
|---|---|---|---|
| `station:<slug>` | hash | admin | Profile the engine routes from |
| `live:<slug>:<node>` | hash, 15 s expiry | engine | Listeners, source in use, now playing, per engine |
| `conns:<slug>` | hash, 15 s expiry | engine | Open connections per engine, for listener limits |
| `engine:nodes` | sorted set | engine | Heartbeat of each engine |
| `node:<node>` | hash, 30 s expiry | engine | Resource figures and audio state of each engine |
| `silent:<node>` | hash, 30 s expiry | engine | Stations with no audio on that engine |
| `format:<slug>` | hash | engine | Codec, sample rate, channels and bitrate last seen on the station's stream |
| `node:<node>:audio_override` | string | admin | Reason, while an administrator forces "no audio" |
| `stats:*` | hash / sorted set | engine | Counters awaiting persistence |
| `flush:<ts>:stats:*` | hash / sorted set | admin | Snapshot being persisted |
| `session:<hash>` | string | admin | Dashboard sessions |
| `login:<ip>` | counter | admin | Sign-in attempt limiter |

## Design decisions

**Relay instead of per-listener proxy.** Proxying each listener to the source would
multiply the load on the station's server, which is the opposite of the goal. It
would also make failover per-connection and mid-stream failover impossible.

**Redis between the two services.** The engine never talks to PostgreSQL. Its hot
path needs one hash read per new listener and nothing per audio chunk, and it keeps
relaying existing streams if Redis or PostgreSQL is briefly unavailable.

**Streams available over plain HTTP.** Many hardware radios and older players cannot
negotiate modern TLS or follow redirects. Only the dashboard and API are forced onto
HTTPS.

**No CDN in front.** Continuous streams are a poor fit for caching proxies, which
buffer responses and limit connection duration. The hostname should resolve directly
to the server.

## Roles and scaling

One codebase is deployed in three roles, selected by Compose profiles
(`COMPOSE_PROFILES` in `.env`, written by the installer):

| Role | Profiles | Services |
|---|---|---|
| both | `master,local-engine` | HAProxy, admin, PostgreSQL, Redis, `audio_engine` |
| master | `master` | HAProxy, admin, PostgreSQL, Redis |
| slave | `slave` | `slave_engine` |

One engine instance serves thousands of listeners; the work per listener is copying
bytes to a socket. Slave nodes add engines; see [Adding servers](SCALING.md).

**Balancing.** HAProxy's streaming backend uses `leastconn` and has no servers in its
configuration file. Every engine, including the one beside the master, is added
through HAProxy's runtime API (`add server`, `set server ... weight/state`,
`del server`).

**Reconciliation.** The desired list is the `engine_nodes` table. The admin service
compares it with `show servers state` and issues only the commands needed, after
every change and every 5 seconds. Runtime-added servers are lost when HAProxy
restarts; the next reconciliation puts them back. Hostnames are resolved by the admin
service, so a container that comes back with a new address is re-added.

**Enrolment.** A slave's engine starts with no Redis address. It obtains one by
presenting a join token to `POST /api/v1/cluster/join`; the master registers it in
`engine_nodes`, triggers a reconciliation, and returns the Redis port and password and
the engine secret. The engine stores the result in its data volume
(`/data/cluster.json`) and reuses it on later starts. A slave without a token serves
only `POST /_cluster/configure`, protected by its setup key, through which the master
delivers a token. Either way the join itself is the same call.

**Engine authentication.** HAProxy adds an `X-Engine-Auth` header carrying the engine
secret to every request and health check. An engine with a secret refuses anything
else with `403`, so a slave's port cannot be used to listen around the master.

**Redis for slaves.** HAProxy exposes Redis on port 6380 as a TCP listener with TLS,
using the gateway's certificate. Slaves connect with `rediss://` and the Redis
password. On a single-server install the port is bound to loopback.

**Per-station silence.** A relay that fails `STATION_FAIL_ROUNDS` source rounds in a
row stops: its listeners are released, its task and source connections end, and the
station is recorded as silent on that engine for `STATION_RETRY_SECS`. During that
time the engine answers requests for the station with `502` without starting a relay;
afterwards the next request triggers a fresh attempt. Editing the station's sources
lifts the refusal at once. Each engine publishes its silent stations as
`silent:<node>` (slug to "since|reason"), which the admin service merges into each
station's `live.no_audio_on` and `source_offline`.

**Audio health.** Each engine counts failed source rounds per station. With every
heartbeat it reads, from Redis, the other engines' audio state, the stations they are
failing on, and when they last received audio for the stations it is failing on
(`audio_at` in `live:<slug>:<node>`). It declares the whole engine `no_audio` when it has
no live relay and is failing on two or more stations that no peer is failing on
(after fewer attempts if a peer received audio for one of them at least 3 seconds
after this engine started failing); never when no peer is healthy. In that state `/healthz` and new stream
requests answer `503`, relays stop (releasing listeners), and the failed sources are
re-tested every 10 seconds. HAProxy retries `502` and `503` answers on another
engine (`retry-on`), which both hides the gap from listeners and is what lets a
second engine start playing the station and so provide the proof. An administrator
can force the state through `node:<name>:audio_override`, which the admin service
keeps in step with the `engine_nodes.audio_override` column.

**Shared state.** Each engine identifies itself with `NODE_ID`, announces itself in
`engine:nodes`, and writes its own `live:<slug>:<node>` and `stats:peak:<node>` keys.
Byte, session and listening-time counters are plain increments, so they add up across
engines by themselves. The admin service sums listeners and peaks across live engines.

**Listener limits.** An engine checks its own connections plus the other engines'
(`conns:<slug>`), which each engine updates the moment a limited station gains a
listener.

**Source connections.** Each engine with listeners for a station holds its own
connection to the source, so a station sees at most one connection per engine.

**Bandwidth.** All listener traffic passes through the master's HAProxy, so slave
nodes relieve CPU and memory but not the master's network link.

### Edge servers

An optional second kind of server (`mode: direct`) removes that last limit. An edge
server runs its own HAProxy and engine and has its own A record for the same domain,
so its listeners never touch the master. Its engine shares the master's Redis like any
other. Its HAProxy forwards `/admin`, `/api` and ACME challenges to a dedicated
listener on the master (port 8444, private network) using the PROXY protocol, so the
master sees the real client address and treats the request as HTTPS. The master's
HAProxy does not route to direct servers; the reconciler skips them.
