# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.4.0] - 2026-10-01

### Added

- **Prebuilt images.** CI builds the engine and admin images for x86-64 and ARM and
  publishes them to the GitHub container registry; the installer downloads them
  instead of compiling on the server. A 1 GB server is now enough.
- `--build-from-source` and `--image-tag` installer options; `INSTALL_FROM`,
  `IMAGE_PREFIX` and `IMAGE_TAG` in `.env`.
- Automatic fallback to building from source when the images cannot be downloaded.

### Changed

- Upgrading is `git pull && ./install.sh`, which downloads the newest images.

## [2.3.0] - 2026-10-01

### Added

- `get.sh`: one-line bootstrap (`curl ... | bash`) that checks the server, installs
  missing tools and Docker on request, downloads the code and starts the installer.
- `scripts/set-repo.sh` to write the repository address into the bootstrap and docs.
- CI workflow (`.github/workflows/ci.yml`), `CONTRIBUTING.md`, `.gitattributes`.

## [2.2.0] - 2026-10-01

### Added

- **Per-station no-audio handling.** A server that gets no audio for one station
  releases that station's listeners and relay, refuses it for 30 seconds
  (`STATION_RETRY_SECS`) and carries on with its other stations. Listeners are served
  by another server when one can play it.
- `live.no_audio_on` and `live.source_offline` on stations; **No audio on <server>**
  and **Source offline** on the dashboard.

### Changed

- A whole server is taken out for lack of audio only when it is failing on two or
  more stations; a single failing station is handled per station.

## [2.1.0] - 2026-10-01

### Added

- **No-audio detection.** An engine that cannot fetch audio from sources while other
  servers can reports it to the master, fails its health check so no listeners are
  sent to it, releases its listeners, and returns by itself when a source works again.
- `PUT /api/v1/servers/{id}/audio-status` and **Mark no audio** in the dashboard to
  set the same state by hand; `audio` on every server in `/servers` and `/capacity`.
- HAProxy retries a listener on another engine when one answers 502 or 503.
- Certificate options in the installer (`--tls letsencrypt | provided | external |
  selfsigned`, `--cert`, `--key`), including HTTPS handled in front of the gateway.
- `CLUSTER_HOST` and `--cluster-host` for masters whose domain points at a proxy.

### Changed

- `--letsencrypt` is now shorthand for `--tls letsencrypt`.

## [2.0.0] - 2026-10-01

### Added

- **Roles.** One codebase and one installer for three roles: `both` (single server),
  `master` (HAProxy, dashboard, API, databases) and `slave` (audio engine only).
- **Slave enrolment.** A slave joins with a one-time token
  (`./install.sh --role slave --master ... --token ...`), or waits and is connected
  from the master's dashboard with its address and setup key. Either way the master
  adds it to HAProxy immediately.
- `scripts/add-server.sh` and `POST /api/v1/cluster/join-tokens` to create the install
  command; **Servers > Add server** in the dashboard for both methods.
- Engines accept requests only from the master's HAProxy (shared engine secret).
- Redis for slave nodes over TLS through HAProxy (port 6380).

### Changed

- **Breaking:** `install.sh` takes `--role`; `.env` gains `ROLE`, `COMPOSE_PROFILES`,
  `LOCAL_ENGINE`, `ENGINE_SECRET`, `CLUSTER_BIND` and `CLUSTER_PORT`.
- HAProxy's streaming backend has no static server; every engine is added at runtime
  and re-applied every 5 seconds.
- Edge servers connect to Redis over TLS and use `RELAY_BIND` for the relay port.

### Removed

- `node/` and `docker-compose.cluster.yml`, replaced by the slave role.
- `PRIVATE_BIND`.

## [1.3.0] - 2026-10-01

### Added

- Edge servers (`edge/`): a second public entry point for the same domain, added as
  another DNS A record. Listeners on an edge server never pass through the main
  gateway; statistics, the dashboard and the API stay on the gateway.
- Servers have a `mode`: `direct` (edge server) or `proxied` (engine behind the
  gateway's HAProxy).
- Relay listener on the gateway (port 8444, private) for dashboard, API and
  certificate-validation requests forwarded by edge servers.

### Changed

- `REDIS_BIND` is now `PRIVATE_BIND` and also publishes the relay port.

## [1.2.0] - 2026-10-01

### Added

- `GET /api/v1/capacity`: CPU, memory, disk and outbound traffic per streaming
  server, with warning and critical levels and an `add_server_recommended` verdict.
  The same figures appear on the dashboard's Servers tab.

## [1.1.0] - 2026-10-01

### Added

- Streaming servers: add, weight, drain and remove engines at runtime from the
  dashboard or `/api/v1/servers`; HAProxy balances listeners across them by least
  connections. Listener counts, statistics and listener limits span all servers.
- `node/` compose file for running an engine on another machine.
- Tenant accounts can create, manage and delete several stations (5 by default,
  adjustable per account), with one API key covering all of them.
- `scripts/try-local.sh`: runs the whole gateway locally with a demo station.
- Redis now requires a password.

### Changed

- Live state in Redis is stored per engine (`live:<slug>:<node>`).
- The streaming backend server is named `local` and uses `leastconn`.

## [1.0.0] - 2026-10-01

### Added

- Relay engine: one source connection per station fanned out to all listeners;
  connects on the first listener and disconnects after the last.
- Byte-for-byte passthrough of audio, content type and ICY headers.
- Automatic failover to a backup source on connect failure, mid-stream drop or stall,
  with automatic return to the primary.
- Support for Icecast, SHOUTcast v1 and v2 sources and for playlist URLs as sources.
- ICY in-stream titles for players that request them; `.m3u` and `.pls` playlists;
  CORS for browser players; streams on both HTTP and HTTPS.
- Optional per-station title and artwork URL, plus fixed station artwork.
- REST API (`/api/v1`) for stations, accounts, API keys, live status, history and
  usage, with interactive OpenAPI documentation at `/api/v1/docs`.
- Administrator and tenant roles with per-tenant isolation; hashed API keys.
- Statistics: live listeners, peak and average listeners, listening hours,
  connections and bytes at minute, hour and day resolution.
- Per-station listener limits, suspend and resume.
- Public now-playing endpoint for web players.
- Dashboard for standalone use.
- Filtering of station URLs so they cannot reach internal addresses.
- Installer, optional Let's Encrypt automation, backup and restore scripts.
