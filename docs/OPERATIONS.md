# Operations

Day-to-day running of the gateway. Commands are run from the project directory, on the master unless a section says otherwise. On a slave node the only service is `slave_engine`.

## Service control

```bash
docker compose ps                         # state of every service
docker compose logs -f audio_engine       # follow one service's log (slave_engine on a slave node)
docker compose restart admin_dashboard    # restart one service
docker compose up -d                      # apply changes to .env or the compose file
docker compose kill -s HUP haproxy_edge   # reload HAProxy config or certificate
```

| Restarting | Effect on listeners |
|---|---|
| `haproxy_edge` (restart) | All listeners disconnect and reconnect. The engines are re-added within a few seconds; until then new listeners get `503` |
| `haproxy_edge` (HUP reload) | None |
| `audio_engine` / a slave's `slave_engine` | That engine's listeners disconnect; players reconnect within seconds and land on the other servers. Drain it first to avoid this |
| `admin_dashboard` | None. The API and dashboard are unavailable briefly |
| `redis_cache` | Existing listeners continue. New listeners get `503` until Redis is back and stations are republished (automatic, within seconds of the admin service reconnecting, at most 5 minutes) |
| `postgres_db` | None. The API returns errors meanwhile; statistics queue in Redis and are written afterwards |

To republish stations immediately after a Redis restart: `docker compose restart admin_dashboard`.

## Monitoring

### Health endpoints

| Check | Expect |
|---|---|
| `GET /api/v1/health` | `200` with `{"status":"ok","database":"ok","cache":"ok"}`; `503` if the database or Redis is unreachable |
| `GET /healthz` | `200 ok` from the engine; `503` if it cannot reach Redis |

Point an external uptime monitor at `/api/v1/health`. For an end-to-end audio check,
have the monitor fetch the first bytes of a known station, for example
`curl -s -m 10 -r 0-1023 -o /dev/null -w '%{http_code}' https://stream.example.com/<slug>`.

### Numbers worth watching

| Signal | Where | Meaning |
|---|---|---|
| Listeners and stations on air | `GET /api/v1/overview` | Current load |
| CPU, memory, disk and traffic per server | `GET /api/v1/capacity`, or the Servers tab | Headroom. `add_server_recommended: true` means it is time to add a streaming server |
| Station on backup | `live.source` is `backup` in `GET /api/v1/stations` | The station's primary source is failing |
| `source unavailable`, `source stalled` | Engine log | A station's source has problems; the station name is in the line |
| `stats flush failed` | Engine log | Redis unreachable from the engine |
| `[stats-flush]` errors | Admin log | PostgreSQL or Redis unreachable from the admin service |
| Keys matching `flush:*` in Redis | `docker compose exec redis_cache redis-cli --scan --pattern 'flush:*'` | Snapshots waiting for PostgreSQL. Should be empty or briefly present |

### Logs

All services log to standard output, collected by Docker. Limit their size in
`/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
```

HAProxy logs one line per finished request. A stream request is logged when the
listener disconnects, with its duration and byte count.

Set `RUST_LOG=debug` on the engine to log each metadata poll failure and more detail
on source connections.

## Backups

Everything that must survive is in PostgreSQL. Redis holds only rebuildable state
and, at most, the last minute of counters.

```bash
./scripts/backup.sh                 # writes backups/gateway-<timestamp>.sql.gz
KEEP_DAYS=30 ./scripts/backup.sh    # and prunes dumps older than 30 days
```

Schedule it and copy the dumps off the server:

```
30 2 * * * KEEP_DAYS=30 /path/to/streamnode/scripts/backup.sh
```

Also keep a copy of `.env` (credentials) and `certs/` somewhere safe.

**Uploaded audio is not in the dump.** With Dropbox connected the files are in your
Dropbox and need nothing more. Without it they exist only in the `media_files` volume;
copy it as well:

```bash
docker run --rm -v streamnode_media_files:/files:ro -v "$PWD/backups":/out alpine \
  tar czf /out/media-files-$(date +%Y%m%d).tar.gz -C /files .
```

### After the rename from radio-gateway

A server installed while the project was called radio-gateway is moved to the new name
by its next update: its data volumes are copied to `streamnode_*` names and the
installation directory moves to `/opt/streamnode`. The old volumes are kept as a
backup and take the same disk space again. When you have seen that stations, accounts,
statistics and uploads are all in place, remove them:

```bash
./scripts/migrate.sh drop-old-data
```

If the update reported that the data was not moved, the server is still running under
its old internal name and nothing needs doing; the message says how to try again.

After restoring a dump without its files, stations whose ident or fallback file is
missing simply play without it, and the file can be uploaded again.

### Restore

```bash
./scripts/restore.sh backups/gateway-20260101-023000.sql.gz
```

This replaces the current database. The admin service is stopped during the restore
and republishes all stations when it starts again. Streams already playing continue.

### Moving to a new server

1. Install on the new server with the same `.env`.
2. Copy the latest dump across and run `./scripts/restore.sh`.
3. Copy `certs/stream.pem`, or issue a new certificate after the DNS change.
4. Point DNS at the new server.
5. Slave nodes keep working if the master's address and `.env` secrets are unchanged. If you addressed the master by IP rather than by name, re-join each slave.

## Routine tasks

### Rotating credentials

**Administrator API key or dashboard password:** edit `ADMIN_API_KEY` or
`ADMIN_PASSWORD` in `.env`, then `docker compose up -d`. The previous key stops
working immediately. Update every integration that used it.

**Other API keys:** create a new one (dashboard or `POST /api/v1/api-keys`), switch
the integration over, then revoke the old one.

**Redis password and engine secret:** these are what a slave node holds. Rotate them
after removing a slave you no longer trust, or if either may have leaked.

1. On the master, set new values for `REDIS_PASSWORD` and `ENGINE_SECRET` in `.env`
   (`openssl rand -hex 24` for each) and run `docker compose up -d`. Listeners on the
   master's own engine reconnect; slave nodes go **Unreachable**, because their old
   credentials no longer work.
2. On each slave you are keeping, join again with a fresh token
   (`scripts/add-server.sh` on the master prints the command). Each returns to
   **Healthy** as it rejoins.

Do it at a quiet time: between the two steps the slaves carry no listeners.

**Database password:** PostgreSQL only reads `POSTGRES_PASSWORD` when the data volume
is first created, so change it in both places:

```bash
# use your POSTGRES_USER and POSTGRES_DB values if you changed them
docker compose exec postgres_db psql -U gateway -d gateway_management \
  -c "ALTER USER gateway PASSWORD 'NEW-PASSWORD'"
# then set POSTGRES_PASSWORD=NEW-PASSWORD in .env
docker compose up -d
```

### Keeping up to date

The dashboard's **Updates** tab shows when a newer version exists, installs it on
request, and can do so automatically at a time of day you choose. Slave nodes follow
their master. `./scripts/update.sh` does the same from the command line. Details:
[Updating](INSTALLATION.md#updating).

### Certificate renewal

With Let's Encrypt, the cron entry from [Installation](INSTALLATION.md#option-a-lets-encrypt-optional-automated)
handles it. With your own certificate, replace `certs/stream.pem` and send HAProxy a
HUP. Check the expiry date with:

```bash
openssl x509 -enddate -noout -in certs/stream.pem
```

### Reviewing changes

`GET /api/v1/audit-log` lists who created, changed, suspended or deleted stations,
accounts and keys, with the address the request came from.

## Capacity

| Resource | Guidance |
|---|---|
| Memory | Engine: about 22 MB plus 25 KB per listener (measured). Allow about 100 KB per listener across the engine, HAProxy and the kernel's network buffers |
| Processor | Engine: about 10% of one core per 1,000 listeners (measured on a 1.7 GHz laptop core over loopback, with `PUBLISH_INTERVAL_MS=400`), whatever the bitrate. HAProxy needs its own share per listener, more for HTTPS. About 0.3% of a core per station on air for silence and noise detection. A file conversion takes one core at the lowest priority while it runs |
| Network | Usually the first limit at higher bitrates: a 1 Gbit/s port carries about 5,800 listeners at 128 kbps, 7,800 at 96 kbps and 2,300 at 320 kbps, leaving a fifth of the port spare |
| File descriptors | One per listener in HAProxy and in the engine. The compose file raises the limits to 131,072 and 65,536 |
| Database growth | One row per active station per minute, removed after the retention period; one permanent row per station per day |

To raise the connection ceiling, increase `maxconn` in `haproxy.cfg` and the `nofile`
limits in `docker-compose.yml` together. To spread the load over more machines, add
slave nodes: [Adding servers](SCALING.md).
