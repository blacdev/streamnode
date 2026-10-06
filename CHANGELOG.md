# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.14.0] - 2026-10-06

### Added

- **The HTTPS certificate in the dashboard.** Updates → HTTPS certificate shows the
  certificate HAProxy serves (issuer, names, expiry, whether browsers trust it) and,
  with Let's Encrypt, what the renewal last did, with a button to obtain or renew it
  now. `GET /api/v1/system/certificate`, `POST /api/v1/system/certificate/renew`.
- `scripts/letsencrypt.sh status`, `schedule install|remove`, `tick` and `renew --force`.

### Changed

- **Let's Encrypt renews by itself.** The installer schedules `scripts/letsencrypt.sh`
  (cron, every 5 minutes): it obtains the certificate, retrying every hour until it
  is issued (for example while DNS spreads), then checks twice a day and renews 30
  days before expiry. Before, renewal needed a cron entry added by hand.
- Let's Encrypt's domain check is answered by the dashboard service from files
  certbot writes to a shared volume (webroot), instead of by HAProxy forwarding to a
  certbot container that had only just started, which could make the check fail.
- Before asking Let's Encrypt, the script checks that the domain resolves and that a
  test file is reachable at `http://DOMAIN/.well-known/acme-challenge/`, and explains
  what is wrong if not.
- A certificate Let's Encrypt had issued before is put in place even when it is not
  renewed; before, re-running the installer could leave the self-signed one in use.
- A failed Let's Encrypt attempt no longer stops the installer: it explains the
  reason and leaves the retries to the scheduler.
- Switching from Let's Encrypt back to `--tls selfsigned` replaces the certificate.

## [2.13.0] - 2026-10-05

### Added

- **A title, artist and image of the station's own.** Each station can be given a
  default title and artist (`default_title`, `default_artist`) and an uploaded image
  (`artwork_file_id`). They are shown while the fallback file plays, when neither the
  stream nor the metadata URL names what is playing, when the metadata URL stops
  answering, and when there is no artwork or an artwork address does not work.
- **Images in the upload library.** JPEG, PNG, WebP and GIF, up to 5 MB, are recognised
  by their content, kept in the account's storage and counted toward its quota, like
  audio. `use=artwork` on upload, `kind` on files, `GET /files?kind=`.
- `GET /api/v1/public/stations/{slug}/artwork` serves a station's image to anyone.
- The engine tries artwork addresses before handing them to players: one that is
  unreachable, or answers with something other than a picture, is passed over, tried
  again each minute, and used again once it works.

### Changed

- A metadata URL that stops answering now gives way after three missed polls even when
  the stream carries no title; before, its last title stayed on show.
- A stream's titles start afresh each time a source is joined, and are not shown over
  the fallback file.
- Artwork is given to players in the stream only as a full address.
- The dashboard's "Audio files" tab is now "Files".

## [2.11.0] - 2026-10-04

### Added

- **Hiss and steady noise count as no audio, however loud.** A stream that is
  pitchless and unchanging for four seconds is recognised as noise: the engine looks at
  the spectrum of the samples it already decodes. Tuned on a recording of a station
  that was looping loud hiss, and checked against music, jazz, classical and speech,
  none of which was mistaken for noise. Per station (`noise_detection`, on by default).
- **Silence level per station** (`silence_threshold_db`), overriding the server's.

- **Plans by bandwidth.** A station can pay for an amount of data each month
  (`plan_type: bandwidth`, `bandwidth_gb`) instead of a number of listeners, with no
  limit on listeners. The allowance starts again each calendar month; used up, the
  station goes off the air until then (capped) or carries on and is charged per
  gigabyte (pay as you go). Prices per gigabyte in the rates. The same stream can be
  several stations on different plans.
- The plan's price is shown in the station form as its numbers are entered;
  `GET /billing/quote` takes `bandwidth_gb`. `GET /billing/history` gives every month
  on record per station.
- **Subscription first, then pay as you go.** Per station (`overage_mode`): capped, as
  before, or pay as you go, where listeners beyond the subscription's number are let in
  and charged: for every so many extra listeners, for every so many minutes, a set
  amount (`payg_block_listeners`, `payg_block_minutes`, `payg_price_per_block`), worked
  out from the minute-by-minute statistics. `listener_ceiling` is the most a station on
  pay as you go may ever have. The bill shows subscriptions, pay as you go so far and
  the total.
- **Storage on pay as you go**, per account (`storage_overage`, `storage_ceiling_mb`,
  `payg_storage_price_per_gb`): uploads beyond the quota are accepted and charged.
- **Notices are the administrator's to tune**: whether they go out by themselves, at
  which levels, and the fewest days between two about the same thing
  (`notices` in the settings). `POST /notifications/send` emails an account a summary
  on request.
- **How long a station has been full.** `usage.at_limit` gives the minutes in which a
  limited station reached its limit today, in the last 7 days and this month, and when
  it last did; with the most listeners at once for each span. On the Billing tab too.

### Changed

- **A station's standing is about now.** `near_limit` and `at_limit` reflect the
  listeners connected at this moment, not the highest count of the month, so a station
  that was briefly full no longer shows as "at its limit" for the rest of the month.
- **Limit notices are about their own span.** The daily notice (90%, 100%) goes out
  only on a day the station got that far, the weekly (75%) only if it did in the last
  seven days. Reaching the limit once no longer produces a notice every day.
- Listening to a stream now costs about 0.3% of a core per station (0.1% with noise
  detection off), up from 0.07%.
- Changing a station's silence or noise settings reconnects its streams.

## [2.10.0] - 2026-10-04

### Added

- **What a listener costs, measured per server.** Each engine reports its own
  processor and memory use, and the master reads HAProxy's; divided by the listeners
  served, that is the cost of a listener on the engine and on the master, through
  which every proxied listener's audio passes. Shown on the Servers tab and in
  `GET /capacity`, with how many listeners the servers can carry at common bitrates
  and what stops them there.
- **Add-a-server calculator** (`POST /capacity/estimate`, and on the Servers tab): for
  a server of a given size, as a slave or an edge server, how much capacity it adds,
  how today's listeners spread, and what happens to the master's traffic.
- **Billing.** A station is charged for its listener limit at its stream's bitrate, an
  account for its storage. The price per listener is worked out from what a server
  costs and how many listeners it carries, plus a margin (`/billing/rates`). Per
  station: discount, fixed price, bitrate to charge at, subscription date. Per account:
  discount. `GET /billing`, `/billing/quote`, `/stations/{slug}/limits`.
- **Billing tab** for every account: each station against its limit, its subscription
  and price, storage, and the account's total.
- **Notices by email** (optional): as a station nears its listener limit, storage
  fills, or a subscription nears its end, more often the closer it gets. SMTP settings
  under Settings; an address per account, which its owner may set.
- An administrator can move a station to another account from the dashboard.
- Per-server port speed (`port_mbps`), used for capacity.
- Guide: [Costs, capacity, billing and limits](docs/BILLING.md).

- **Files in another format can be converted for a station, with the owner's
  agreement.** WAV, FLAC, M4A, Ogg, or MP3/AAC with other settings are re-encoded to
  the station's stream format in the background and stored in place of the upload
  (`convert=true`, `POST /files/{id}/convert`, a tick box and a question in the
  dashboard). Without agreement such a file is refused as before, with the advice that
  a file already in the stream's format is best. Not available for HE-AAC stations.
- **Loudness matching.** The engine measures each stream's average level
  (`live.stream_format.level_db`) and converted files are brought to it.
- Files report `status` (`ready`, `converting`, `failed`), `converted` and `gain_db`.

### Changed

- **About a quarter of the processor cost per listener.** Audio is now gathered for
  400 ms (`PUBLISH_INTERVAL_MS`) and sent to listeners in a few larger pieces a second
  instead of many small ones. Measured on the engine alone: 41% of a core per 1,000
  listeners before, 10% after.
- File conversion is confined to one processor core at the lowest priority.
- A returning stream must now deliver five seconds of real audio before the station
  goes back to it (was one second), and fades last a second and a half each way (was
  half a second).
- **One ident per change of source.** When the primary fails and the backup cannot be
  reached, the station plays the ident once and goes straight to the fallback file,
  instead of an ident, a second wait and a second ident. When the primary and backup
  return together, one ident leads straight to the primary.
- **Silence is now detected by listening to the stream.** Twice a second the engine
  decodes a short run of frames and measures their level, using FFmpeg's MP3 and AAC
  decoders (`ffmpeg-next`). A stream quieter than `SILENCE_THRESHOLD_DB` (default -55 dB)
  for the station's failover delay counts as having no audio. This catches the hiss of
  an open input as well as digital silence, and works for HE-AAC, where silence could
  not be recognised before. About nine tenths of the stream is never decoded; the cost
  is about 0.07% of a processor core per station on air.
- What listeners receive is unchanged: the stream's own bytes. Decoded audio is only
  measured.
- HE-AAC streams are recognised from the decoded audio rather than guessed from the
  headers once a station has been on air.
- The admin image now includes `ffmpeg`, used only for converting uploads.
- The engine image builds FFmpeg's two decoders from source and links them in
  (`rust_src/build-ffmpeg.sh`). The image needs nothing more at run time; building it
  from source takes a few minutes longer.

## [2.9.0] - 2026-10-03

### Changed

- **The project is now called StreamNode** everywhere: the dashboard and API titles,
  the documentation, the default installation directory (`/opt/streamnode`), the
  Compose project (`streamnode`), the engine binary and its `User-Agent`
  (`StreamNode/1.0`), and the installer's environment variables (`STREAMNODE_*`).
- **Existing servers are moved to the new name by the update itself.** Their data
  volumes (database, statistics, uploads, certificates, a slave's enrolment) are copied
  from `radio-gateway_*` to `streamnode_*` with the services stopped, and the server
  starts under the new name with everything in place. `/opt/radio-gateway` is moved to
  `/opt/streamnode`, with a link left at the old path, and scheduled jobs follow it.
  The old `RADIO_GATEWAY_*` variables are still accepted.
- The old volumes are kept as a backup and take up the same space again until removed
  with `scripts/migrate.sh drop-old-data`.
- If the data cannot be moved (a full disk, say), nothing is lost: the copies are
  discarded and the server carries on under its old internal name
  (`COMPOSE_PROJECT_NAME=radio-gateway` in `.env`), saying how to try again.
- A station source that only admits the old `User-Agent` (`RadioGateway/1.0`) needs
  `UPSTREAM_USER_AGENT=RadioGateway/1.0` set, or its allow-list updated.
- An optional edge server (`edge/`) is started by hand and is not migrated: before
  updating one, run `docker compose -p radio-gateway-edge down` in its `edge/` directory.

## [2.8.0] - 2026-10-02

### Added

- **Failover delay per station** (`failover_delay_secs`, default 6): how long a stream
  may be without audio before the station moves on. A stream that recovers within the
  delay is simply carried on with. Returning to a stream that is back is immediate.
- **Clean returns.** The ident, if the station has one, introduces the returning
  stream. Without an ident, MP3 stations fade out what is playing and fade the stream
  in, done by adjusting each frame's stated volume rather than converting audio. If
  only silence is playing, the stream starts at once.
- **Silence counts as no audio.** A stream that keeps sending but carries only digital
  silence fails over like one that is down. Read from MP3 and AAC frame headers
  without decoding; can be switched off per station (`silence_detection`).
- **Fallback audio.** An uploaded file, looped when neither the primary nor the backup
  stream has audio. The station returns to a live stream by itself.
- **Idents.** An optional short clip played at every change of source. The longest allowed ident (5 s by default) is set by the
  administrator.
- **Audio files library** with per-account storage quotas, set by the administrator
  for everyone or per account. API: `/files`, `/settings`, `storage_quota_mb` on
  accounts. Dashboard: *Audio files* and *Settings* tabs.
- **Dropbox storage.** The administrator connects a Dropbox app (OAuth); uploaded files
  are kept there, with a size-limited copy on the server (`FILE_CACHE_MB`).
- Uploaded files are never converted. One that does not match its station's stream, or
  is not MP3/AAC, too long for an ident or over quota, is refused with the reason and
  what to change.
- **Stream types.** `GET /stream-types` (no sign-in needed) and the station form list
  which kinds of stream are supported and what is available on each. Once a station
  has played, the dashboard and `live.stream_format` show its detected type (MP3, AAC,
  HE-AAC or other) and the features that apply to it.
- A stream labelled MP3 or AAC that is really something else, or that changes format
  while playing, is relayed as it arrives instead of being treated as silent.
- Variable-bitrate MP3 streams are recognised; files for them are not held to a bitrate.
- `live.source` can be `fallback`.
- Guide: [Failover, idents and fallback audio](docs/FAILOVER.md).

### Changed

- Switches between sources now happen on audio frame boundaries for MP3 and AAC.
- A stream that stalls mid-broadcast is given up on after the station's failover delay
  rather than `STALL_TIMEOUT_SECS`, which now only covers a source's first bytes.
- New `media_files` volume on the master; the local engine is given `ADMIN_URL`.

## [2.7.0] - 2026-10-02

### Added

- **Updates tab in the dashboard:** running and latest version, a switch and time of
  day for automatic updates, "Install the update now", and what the updater last did.
  API: `PUT /system/update-settings`, `POST /system/update`.
- **Slave nodes follow their master's version** automatically.
- **Automatic migration of older installations** (`scripts/migrate.sh`, run by the
  installer): full clones are slimmed down, old settings are converted, the earlier
  update cron entry is carried over. Nothing has to be done by hand.
- The installer sets up the update scheduler itself.

### Changed

- The command generated for adding a server is now the one-line bootstrap
  (`curl ... get.sh | bash -s -- --role slave ...`), so the new server can be empty.
  It includes `--insecure` by itself when the master has no trusted certificate.
- `scripts/update.sh auto on|off` now sets the same switch the dashboard does; the
  scheduler entry is managed with `scripts/update.sh schedule install|remove`.

### Fixed

- Removing a cron entry failed when it was the only entry in the crontab.

## [2.6.0] - 2026-10-02

### Added

- **Update monitoring.** The dashboard shows a notice when the repository has a newer
  version (`GET /api/v1/system/version`). `scripts/update.sh` checks and installs
  updates, optionally every day (`auto on`), backing up first and waiting until the
  new version's images are published.
- `get.sh` options `--ref`, `--with-source` and `--non-interactive`; installer option
  `--prebuilt`.

### Changed

- **Servers no longer hold the source code.** `get.sh` downloads only the runtime
  files (about 100 KB) instead of cloning the repository, and `git` is no longer
  required. The source is fetched on demand for `--build-from-source` and removed
  again when a server returns to prebuilt images. Existing full copies are slimmed
  down on the next run.
- Build instructions moved from `docker-compose.yml` to `docker-compose.build.yml`.

## [2.5.0] - 2026-10-01

### Added

- **Access by IP address out of the box.** The dashboard and API are served over HTTP
  when requested by the server's IP address; the HTTPS redirect applies to the domain
  name only. URLs shown follow the address the request came in on.
- **Installing without a domain.** `./install.sh --role both` with no `--domain` sets
  the gateway up for the server's IP address; a domain can be added later.

- `scripts/uninstall.sh`: removes an installation of any version or role, for a clean
  reinstall.
- `--http-port` and `--https-port` installer options.

### Changed

- `--tls external` no longer creates a certificate or opens an HTTPS listener. An
  internal certificate is created only for the Redis link, and only on a server that
  takes slave nodes.

### Fixed

- HAProxy accepted at most 2,000 simultaneous connections per frontend (its built-in
  default); the limit is now 50,000, matching the global setting.
- The installer now asks how HTTPS is provided on a fresh interactive install with a
  domain (it previously kept the self-signed default without asking).
- `scripts/add-server.sh` prints the master's real address when no public URL is set.

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
