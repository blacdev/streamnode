# Radio Gateway

A self-hosted rebroadcast gateway for internet radio. A station gives it the URL of
its existing stream; the gateway opens **one** connection to that stream and fans it
out to every listener. The station's own server carries one listener's worth of load
no matter how large the audience is, and still gets listener counts, history and
bandwidth figures.

- **Audio is never touched.** Codec, bitrate and stream headers go out exactly as the
  source sends them. A 96 kbps stream leaves as 96 kbps.
- **On-demand.** The gateway connects to a station's source when the first listener
  arrives and disconnects shortly after the last one leaves.
- **Silent servers take themselves out.** A server that cannot fetch audio while the
  others can tells the master, stops receiving listeners and returns by itself when
  it recovers. The same switch is available through the API.
- **Automatic failover.** An optional backup URL takes over when the primary cannot be
  reached, drops mid-stream or stalls, without disconnecting listeners. The gateway
  switches back when the primary recovers.
- **Works with everything.** Winamp, VLC, hardware Wi-Fi radios, TuneIn-style
  directories and browser players: ICY headers and song titles, `.m3u`/`.pls`
  playlists, CORS, and plain HTTP alongside HTTPS.
- **One account, many stations.** A station owner manages all of their stations,
  statistics and API keys from a single account.
- **Grows with you.** Install one server, or a master with slave nodes. A new slave
  joins with one command and HAProxy shares listeners with it at once; the domain never
  changes and statistics stay in one place. A capacity report says when to add one.
- **API first.** Everything is done through a REST API, so an existing platform
  (billing system, hosting panel, your own app) can drive it with its own accounts
  and its own interface. A small dashboard is included for standalone use.
- **Statistics.** Live listeners, peak and average listeners, listening hours,
  connections and bytes, per minute, hour and day.
- **Title and artwork.** Song titles come from the stream, or from a separate URL the
  station supplies for title and artwork.

## Quick start

Requirements: a Linux server with Docker and Docker Compose, ports 80 and 443 open,
and a DNS record (for example `stream.example.com`) pointing **directly** at the
server.

On the server, run:

```bash
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash
```

It checks the server, offers to install Docker if it is missing, downloads the code to
`/opt/radio-gateway` and starts the installer. The services run in Docker from
prebuilt images, so nothing is compiled on the server and a small one is enough. The
installer asks which role the server has, the domain, and how HTTPS is provided. At the end it prints the dashboard address,
password and administrator API key.

If you already have the code, run the installer directly:

```bash
./install.sh --role both --domain stream.example.com
```

`both` puts everything on one server. The same installer sets up the other two roles:

| Role | What it installs |
|---|---|
| `both` | Everything on one server |
| `master` | HAProxy, dashboard, API and databases: the public entry point |
| `slave` | The audio engine only; joins a master and shares its listeners |

```bash
./install.sh --role master --domain stream.example.com          # the entry point
./scripts/add-server.sh                                         # prints the command for a new slave
./install.sh --role slave --master https://stream.example.com --token rgj_...   # on the new server
```

Run `./install.sh` with no options to be asked.

The installer asks how HTTPS for the domain is provided, or takes `--tls`: a free
Let's Encrypt certificate (optional), your own certificate files, or HTTPS handled by
something in front of the server.

```bash
./install.sh --role both --domain stream.example.com --tls letsencrypt --email you@example.com
```

Then add a station, from the dashboard at `https://stream.example.com/admin/` or with
the API:

```bash
curl -X PUT https://stream.example.com/api/v1/stations/powerbeats \
  -H "X-API-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Power Beats FM", "primary_url": "https://encoder.example.com/live"}'
```

Listeners tune in at `https://stream.example.com/powerbeats`.

## Try it on your own machine

```bash
./scripts/try-local.sh
```

This builds everything, starts it on `http://localhost:8080` with a demo radio station
and a second streaming server, and prints the sign-in details and things to try
(failover, load spreading, listener limits). It keeps its own settings and data, so
it does not interfere with a real installation. `./scripts/try-local.sh help` lists
the other commands.

## Documentation

| Document | For | Contents |
|---|---|---|
| [Installation](docs/INSTALLATION.md) | Operators | Roles (both, master, slave), requirements, certificates, upgrades |
| [Configuration](docs/CONFIGURATION.md) | Operators | Every setting in `.env` |
| [Adding servers](docs/SCALING.md) | Operators | Slave nodes: sharing listeners across servers without changing the domain |
| [Operations](docs/OPERATIONS.md) | Operators | Monitoring, logs, backups, capacity, routine tasks |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Operators | Symptoms, causes and fixes |
| [Security](docs/SECURITY.md) | Operators, reviewers | Threat model, controls, hardening checklist |
| [API guide](docs/API.md) | Developers | Authentication, conventions, worked examples |
| [Integration guide](docs/INTEGRATION.md) | Developers | Connecting a billing system or existing platform |
| [Architecture](docs/ARCHITECTURE.md) | Developers | Components, data flow, design decisions |
| [Station guide](docs/STATION_GUIDE.md) | Station owners | What to provide, title and artwork URL formats |
| [Listener and player guide](docs/PLAYERS.md) | Station owners, support | Stream URLs, player compatibility, web player embed |
| [Changelog](CHANGELOG.md) | Everyone | Release history |

The interactive API reference (OpenAPI/Swagger) is served by the gateway itself at
`/api/v1/docs`, with the raw specification at `/api/v1/openapi.json`.

## Layout

```
get.sh                One-line bootstrap: checks the server, downloads the code, runs install.sh
install.sh            Installer for every role: both, master, slave
docker-compose.yml    All services; the role decides which ones start
edge/                 Optional edge server: own HAProxy and engine, same domain
demo/                 Demo radio source used by scripts/try-local.sh
haproxy.cfg           Edge proxy: TLS, routing, rate limiting
rust_src/             Audio relay engine (Rust)
admin_src/            Management API, dashboard, statistics (Node.js)
  migrations/         Database schema, applied automatically on start
  public/             Dashboard
scripts/              add-server, local test, Let's Encrypt, backup and restore
docs/                 Documentation
```

## Tests

```bash
cd rust_src && cargo test       # relay engine
cd admin_src && npm install && npm test   # management API
```
