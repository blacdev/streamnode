# Configuration

All settings live in `.env` next to `docker-compose.yml`. The tables below describe a master or single-server install unless they say otherwise. After changing it, apply
with:

```bash
docker compose up -d
```

Only the services whose settings changed are restarted.

## Images

| Variable | Default | Description |
|---|---|---|
| `INSTALL_FROM` | `images` | `images` downloads the prebuilt images; `source` compiles them on the server (`--build-from-source`) |
| `IMAGE_PREFIX` | your repository's registry | Where the images are, e.g. `ghcr.io/acme/streamnode`. The images are `<prefix>/engine` and `<prefix>/admin` |
| `IMAGE_TAG` | `latest` | Version to run: `latest`, or a release such as `v2.4.0` (`--image-tag`) |

| `UPDATE_REPO` | the repository installed from | Repository watched for new versions, as `owner/name`. Empty turns the dashboard's update notice off |
| `UPDATE_BRANCH` | `main` | Branch whose latest commit counts as the newest version |
| `UPDATE_FOLLOW_MASTER` | `true` | On a slave node: follow the version the master runs. `false` leaves the slave to be updated by hand |
| `COMPOSE_FILE` | unset | Set to `docker-compose.yml:docker-compose.build.yml` by `--build-from-source`, so the build instructions are included |

These apply to every role. See [Images](INSTALLATION.md#images) and
[Updating](INSTALLATION.md#updating).

## General

| Variable | Default | Description |
|---|---|---|
| `DOMAIN` | the server's IP address | Public hostname, or the server's IP address when installed without a domain. Used for the certificate, the HTTPS redirect and `scripts/letsencrypt.sh` |
| `PUBLIC_BASE_URL` | `https://<domain>`; empty without a domain | Origin placed in `stream_url`, `playlist_urls` and slave install commands. When empty it is taken from each request. Requests made to the server's IP address always get URLs on that address. Players are told the address of a station's uploaded image in the stream only when this is set, since they need a full address; the API gives it either way |
| `TLS_MODE` | set by the installer | Where the domain's certificate comes from: `letsencrypt`, `provided`, `external` (HTTPS handled in front of this server) or `selfsigned`. See [Certificates](INSTALLATION.md#certificates) |
| `HTTP_BIND` | `0.0.0.0` | Address the HTTP port is published on. `0.0.0.0` is every IPv4 interface; use `::` to publish on IPv6 as well |
| `HTTP_PORT` | `80` | Host port for plain HTTP. Asked by the installer |
| `HTTPS_PORT` | `443` | Host port for HTTPS. Asked by the installer (not with `TLS_MODE=external`, where nothing listens on it). A request for `http://DOMAIN:PORT/` is redirected to HTTPS on this port |
| `HTTPS_PORT_AUTO` | empty | Set by the installer when, with `TLS_MODE=external`, it moved `HTTPS_PORT` off a port another program holds; the next run starts from 443 again |
| `HTTPS_BIND` | `0.0.0.0` | Address the HTTPS port is published on. `127.0.0.1` with `TLS_MODE=external`, where nothing listens on it |

## Credentials

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_USER` | `gateway` | Database user (internal network only) |
| `POSTGRES_PASSWORD` | generated | Database password. **Changing it after the first start does not change the password inside an existing database**; see [Operations](OPERATIONS.md#rotating-credentials) |
| `POSTGRES_DB` | `gateway_management` | Database name |
| `REDIS_PASSWORD` | generated | Redis password, used by the master's own services and given to slave nodes when they join |
| `ADMIN_USERNAME` | `admin` | Operator account for the dashboard |
| `ADMIN_PASSWORD` | generated | Operator password. Re-applied from `.env` on every start, so edit it here to change it |
| `ADMIN_API_KEY` | generated | Administrator API key for integrations. Must start with `rgw_` and be at least 36 characters. Re-applied on every start; changing it revokes the previous value |

## API access from browsers

| Variable | Default | Description |
|---|---|---|
| `CORS_ORIGINS` | empty | Browser origins allowed to call the authenticated API: a comma-separated list such as `https://panel.example.com`, or `*`. Leave empty when only servers call the API. The public now-playing endpoint and the streams always allow any origin |

## Accounts

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_MAX_STATIONS` | `5` | How many stations a new tenant account may create and manage. Change it per account from the dashboard (Accounts > Station limit) or with `PATCH /users/{id}`. `0` means only administrators create stations |

## Uploaded audio

Idents and fallback files; see [Failover, idents and fallback audio](FAILOVER.md).
Quotas, the ident length and the Dropbox connection are changed while running, in the
dashboard under **Settings** or with `PUT /settings`, not in `.env`.

| Variable | Default | Description |
|---|---|---|
| `FILE_CACHE_MB` | `2048` | With Dropbox connected: how many megabytes of files that are in Dropbox are also kept on the master for immediate use. Files beyond it are dropped locally and fetched again when needed. Without Dropbox every file stays on the master and this has no effect |

## Roles and slave nodes

See [Installation](INSTALLATION.md) and [Adding servers](SCALING.md).

| Variable | Default | Description |
|---|---|---|
| `ROLE` | set by the installer | `both`, `master` or `slave`. Recorded so re-running the installer keeps the role |
| `COMPOSE_PROFILES` | set by the installer | Which services start: `master`, `master,local-engine` (both) or `slave` |
| `LOCAL_ENGINE` | `audio_engine:3000` for `both`, empty for `master` | The engine on the master itself |
| `ENGINE_SECRET` | generated | Secret HAProxy sends to every engine. Engines refuse requests without it. Slave nodes receive it when they join |
| `CLUSTER_BIND` | `0.0.0.0` for `master`, `127.0.0.1` for `both` | Address on which Redis-over-TLS is published for slave nodes. Set to `0.0.0.0` on a `both` install before adding slaves |
| `CLUSTER_PORT` | `6380` | Port for the above |
| `CLUSTER_CERT` | `/etc/haproxy/certs/stream.pem` | Certificate presented on the Redis port for slave nodes (path inside the HAProxy container). With `TLS_MODE=external` it is an internal one, `certs/cluster.pem`; empty means the server takes no slave nodes |
| `CLUSTER_HOST` | empty | Address slave nodes use to reach the master directly. Needed when the domain points at a proxy in front of the master; otherwise slaves use the domain |
| `RELAY_BIND` | `127.0.0.1` | Private address for the relay port used by optional edge servers |
| `RELAY_PORT` | `8444` | Port for the above |
| `FORCE_HTTPS` | `true` with a domain, `false` without | `true` redirects the dashboard and API to HTTPS when they are requested by the domain name. Requests made to the server's IP address are never redirected |

### A slave node's `.env`

Written by `./install.sh --role slave`.

| Variable | Description |
|---|---|
| `ROLE`, `COMPOSE_PROFILES` | `slave` |
| `NODE_ID` | The server's name on the master (`--name`). Must be unique |
| `MASTER_URL` | The master's address (`--master`) |
| `JOIN_TOKEN` | One-time token (`--token`). The installer clears it after joining |
| `NODE_SETUP_KEY` | Lets an administrator finish the setup from the master's dashboard |
| `ADVERTISE_ADDRESS` | Address the master should use to reach this server (`--advertise`). Empty: the address the join request comes from |
| `ENGINE_PORT` | Port the engine listens on. Default 3000 |
| `ENGINE_BIND` | Address the port is published on. Default `0.0.0.0`; set to a private address to restrict it |
| `ALLOW_INSECURE_TLS` | `true` accepts a master with a self-signed certificate (`--insecure`) |

A slave follows the master's `ALLOW_PRIVATE_SOURCES` setting. The engine tuning
variables below may be added to a slave's `.env` to override the defaults there.

## Sources

| Variable | Default | Description |
|---|---|---|
| `ALLOW_PRIVATE_SOURCES` | `false` | Allow station URLs on private, loopback and link-local addresses. Needed only for development or encoders on the same private network. Leave `false` on a multi-tenant gateway |

## Engine behaviour

| Variable | Default | Description |
|---|---|---|
| `IDLE_GRACE_SECS` | `10` | How long the gateway stays connected to a source after its last listener leaves |
| `STALL_TIMEOUT_SECS` | `10` | How long a source may take to start sending after it accepts a connection. Once a station is playing, the station's own failover delay (6 seconds by default) decides when a stream without audio is given up on |
| `PRIMARY_RETRY_SECS` | `30` | No longer slows the return to a stream: while a station plays its backup or fallback file, a stream that is down is tried again every 2 seconds (or this often, if lower) |
| `SILENCE_THRESHOLD_DB` | `-55` | How quiet a stream must be to count as silent, in dB below full level (from `-90` to `-10`). The default treats digital silence and the faint hiss of an open input as silence. This is the server's default: a station can have its own level, and loud hiss is caught separately by noise detection (both in the station's form). Set per server; slave nodes have their own `.env` |
| `METADATA_POLL_SECS` | `10` | How often a station's title and artwork URL is fetched while it has listeners |
| `STATION_FAIL_ROUNDS` | `3` | Failed attempts on a station's sources (primary and backup together count as one) after which a server gives up on that station, releasing its listeners and resources |
| `STATION_RETRY_SECS` | `30` | How long the server then refuses that station before trying its sources again |
| `BURST_BYTES` | `65536` | Recent audio sent to a new listener at once so playback starts immediately. Larger values start faster on high-bitrate streams and add delay on low-bitrate ones (64 KB is about 4 s at 128 kbps, 16 s at 32 kbps) |

The following are read by the engine but not listed in `.env.example`; add them to the
`audio_engine` service in `docker-compose.yml` if you need them.

| Variable | Default | Description |
|---|---|---|
| `CONNECT_TIMEOUT_SECS` | `5` | TCP/TLS connect timeout to a source |
| `PUBLISH_INTERVAL_MS` | `400` | How long audio is gathered before it is sent on to listeners. Sending a few larger pieces a second rather than many small ones is what keeps the processor cost per listener low; at 400 it is about a quarter of what `0` costs. Listeners hear the stream this much later, which players' own buffers dwarf. From `0` to `2000` |
| `READY_TIMEOUT_SECS` | `15` | How long a new listener waits for a source before receiving an error |
| `CONFIG_REFRESH_SECS` | `5` | How quickly a running relay notices edits, suspension or deletion |
| `STATS_FLUSH_SECS` | `2` | How often counters and live state are written to Redis |
| `UPSTREAM_USER_AGENT` | `StreamNode/1.0` | User-Agent presented to sources |
| `RUST_LOG` | `info` | Log level: `error`, `warn`, `info`, `debug` |
| `NODE_ID` | `local` on the master | Name this engine reports under and joins with |
| `ADMIN_URL` | `http://admin_dashboard:8000` on the master | Where the engine on the master's own server fetches idents and fallback files from. Slave nodes use the master address they joined with |
| `DISK_PATH` | `/` | Filesystem whose free space is reported as the server's disk |

## Statistics

| Variable | Default | Description |
|---|---|---|
| `STATS_MINUTE_RETENTION_DAYS` | `90` | How long minute- and hour-resolution history is kept. Daily totals are permanent |

Also read by the admin service (add under `admin_dashboard` in `docker-compose.yml`):

| Variable | Default | Description |
|---|---|---|
| `STATS_FLUSH_SECS` | `60` | How often counters are moved from Redis to PostgreSQL |
| `STATION_SYNC_SECS` | `300` | How often every station profile is republished to Redis |
| `SESSION_TTL_SECS` | `43200` | Dashboard session lifetime |
| `AUDIT_RETENTION_DAYS` | `365` | How long audit log entries are kept |
| `HAPROXY_ADMIN` | `haproxy_edge:9999` | HAProxy runtime API used to manage streaming servers. Empty switches server management off |
| `HAPROXY_SYNC_SECS` | `5` | How often the server list is re-applied to HAProxy |
| `JOIN_TOKEN_MINUTES` | `60` | Default lifetime of a join token |
| `CAPACITY_WARNING_PERCENT` | `75` | CPU, memory or disk use at which a server is flagged as high |
| `CAPACITY_CRITICAL_PERCENT` | `90` | Level at which it is flagged as critical and another server is recommended |

## Let's Encrypt

| Variable | Default | Description |
|---|---|---|
| `LETSENCRYPT_EMAIL` | empty | Contact address for expiry notices. Required with `TLS_MODE=letsencrypt` |

The certificate is obtained and renewed by a scheduler the installer sets up; see
[Installation](INSTALLATION.md#lets-encrypt).

## HAProxy

Edge behaviour is set in `haproxy.cfg`. The values most likely to need changing:

| Setting | Default | Purpose |
|---|---|---|
| `maxconn` | `50000` | Maximum simultaneous connections |
| `timeout client` / `timeout server` | `60s` | A listener that stops reading, or a stream with no audio, is closed after this long |
| `sc_http_req_rate(0) gt 300` | 300 requests per 10 s | API rate limit per client address |
| `ssl-min-ver` | `TLSv1.2` | Lowest TLS version accepted |

Reload after editing, without disconnecting listeners:

```bash
docker compose kill -s HUP haproxy_edge
```
