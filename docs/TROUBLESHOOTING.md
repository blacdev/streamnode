# Troubleshooting

Start with the two logs that explain most problems:

```bash
docker compose logs --tail 100 audio_engine      # source connections, failover
docker compose logs --tail 100 admin_dashboard   # API, statistics, start-up
```

## What a listener receives

| Response | Body | Meaning |
|---|---|---|
| `404` | `Station not found` | No station has that slug (slugs are lower-case) |
| `502` | `Station source offline` | Neither the primary nor the backup delivered audio, on any server that was tried |
| `504` | `Station source did not respond` | The source did not deliver audio within 15 seconds |
| `503` | `Station suspended` | The station is suspended |
| `503` | `Listener limit reached` | The station's `max_listeners` is reached |
| `503` | `Station registry unavailable` | The engine cannot reach Redis |
| `503` | HAProxy error page | No engine is available: none added yet, or all are down or draining |

## A station will not play

**Check the engine log for the station's name.** The line says why the source was
rejected.

| Log message | Cause | Fix |
|---|---|---|
| `source answered HTTP 404` (or 401, 403) | Wrong URL or mount point, or the source needs credentials | Open the URL in VLC from another machine; correct it |
| `does not resolve to a public address` / `source address is not public` | The URL points at a private or internal address | Use the public address. For a genuine private-network encoder, see `ALLOW_PRIVATE_SOURCES` |
| `source returned text/html, not an audio stream` | The URL is a web page (a player page or status page), not the stream | Use the direct stream URL |
| `HLS/DASH sources are not supported` | The URL is an `.m3u8` or DASH manifest | Use the station's Icecast/SHOUTcast URL |
| `source connected but sent no audio` | The mount exists but the encoder is not sending | Check the encoder |
| `timed out`, `connection refused`, `dns error` | Source down, firewall, or wrong host or port | Test from the server: `docker compose exec admin_dashboard wget -S -O /dev/null <url>` (stop it with Ctrl-C) |
| `invalid peer certificate` | The source's HTTPS certificate is expired or self-signed | Fix the certificate, or use the source's `http://` URL |

**The source blocks the gateway.** Some providers limit connections per address or
filter by User-Agent. The gateway makes one connection per station from the server's
address with the User-Agent `RadioGateway/1.0` (configurable with
`UPSTREAM_USER_AGENT`).

## Audio problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Playback cuts out every few minutes | A proxy or CDN in front of the gateway | Point DNS directly at the server; see [Installation](INSTALLATION.md#dns-do-not-proxy-the-hostname) |
| Short gap, then audio continues | Failover between primary and backup. The log shows `source read failed` or `source stalled` | Expected. Investigate the station's primary source if frequent |
| Garbled audio after a failover | Primary and backup use different codecs or sample rates | Make both sources the same format |
| Clicks or chirps on one player only | That player ignores stream metadata it asked for | Rare; use the `.m3u` playlist URL in that player |
| Starts with several seconds of delay | The burst buffer on a low-bitrate stream | Lower `BURST_BYTES` |
| Slow start | Burst buffer too small for a high-bitrate stream | Raise `BURST_BYTES` |
| Stream stops after exactly 60 s with no audio | The source went silent and HAProxy closed the idle connection | Fix the source; add a backup URL |

## Players and devices

| Symptom | Fix |
|---|---|
| Hardware radio or old player cannot connect | Give it the `http://` URL, not `https://` |
| Browser refuses to play on an `https://` page | The page must use the `https://` stream URL (mixed content is blocked) |
| Browser player works but shows no title | Browsers do not read in-stream titles. Poll `GET /api/v1/public/stations/<slug>/now-playing` |
| Certificate warning | The self-signed certificate is still in place; see [Certificates](INSTALLATION.md#certificates) |
| Directory rejects the URL | Submit the plain stream URL, or the `.m3u`/`.pls` URL if it asks for a playlist |

## Titles and artwork

| Symptom | Cause | Fix |
|---|---|---|
| No title at all | The source sends no metadata and no metadata URL is set | Enable metadata in the encoder, or set the station's title and artwork URL |
| Title is empty while nobody is listening | Titles are only tracked while the station has listeners | Expected |
| Metadata URL set but stream titles shown | The URL is failing, so the gateway fell back to stream titles | Run the engine with `RUST_LOG=debug` and look for `metadata URL poll failed`; check the format in the [Station guide](STATION_GUIDE.md#title-and-artwork-url) |
| Wrong characters in titles | The source sends a legacy encoding other than Latin-1 | Set the encoder to UTF-8 |

## Statistics

| Symptom | Cause | Fix |
|---|---|---|
| Listener count lags by a few seconds | Live state is refreshed every 2 seconds | Expected |
| History is a minute behind | Counters are persisted once a minute | Expected |
| No history is being recorded | PostgreSQL unreachable from the admin service | Check `docker compose logs admin_dashboard` for `[stats-flush]`. Data queues in Redis and is written when the database returns |
| A station shows more listeners than expected | Monitoring probes and directory crawlers that fetch audio count as listeners while connected | Have monitors use `HEAD`, which is not counted |
| Usage totals differ slightly from a per-minute sum | `/usage` works in whole UTC days | Compare like with like |

## API and dashboard

| Symptom | Cause | Fix |
|---|---|---|
| `401 unauthorized` | Missing or wrong key, or an expired dashboard session | Send `X-API-Key`; sign in again |
| `403` on creating a station as a tenant | The account's station limit is reached | An administrator raises it: Accounts > Station limit, or `PATCH /users/{id}` with `max_stations` |
| `404` for a station that exists | The key belongs to a tenant that does not own it | Use the owner's key or an administrator key |
| `409 slug_taken` | Another station uses the slug | Choose another slug |
| `422 validation_failed` | A field is invalid; `details` names it | Correct the field |
| `429` from HAProxy | More than 300 API requests in 10 seconds from one address | Slow the client down, or raise the limit in `haproxy.cfg` |
| `429 too_many_attempts` on sign-in | Ten failed sign-ins from one address in 15 minutes | Wait, or clear it: `docker compose exec redis_cache redis-cli --scan --pattern 'login:*'` then `DEL` the key |
| Cannot sign in after install | Wrong password | It is `ADMIN_PASSWORD` in `.env` |
| Browser calls to the API fail with a CORS error | The page's origin is not allowed | Add it to `CORS_ORIGINS` |

## Slave nodes

On a slave, the engine's log is `docker compose logs slave_engine`.

| Symptom | Cause | Fix |
|---|---|---|
| Installer: `Cannot reach the master` | Wrong address, or ports 80/443 closed on the master | Check `--master`; `curl https://<master>/api/v1/health` from the slave |
| Installer: `certificate cannot be verified` | The master still has its self-signed certificate | Install a real certificate on the master, or add `--insecure` |
| `The join token has expired` / `has already been used` | Tokens work once and for an hour | Create a new one: `scripts/add-server.sh` on the master |
| `This join token was issued for X, but the request came from Y` | The slave reaches the master from a different address than the one entered on the dashboard | Enter the address the master sees, or use the one-command method instead |
| `"<name>" is the name of the engine on the master itself` | A slave named `local` | Install it with `--name something-else` |
| Dashboard: `Could not reach <address>:3000` | The master cannot open the slave's engine port | Check the address, that the slave is running, and its firewall |
| Dashboard: `The setup key is not correct` | Typo, or the key belongs to another server | It is `NODE_SETUP_KEY` in the slave's `.env` |
| Dashboard: `already set up or is not waiting for setup` | That slave has already joined a master | Nothing to do; or re-join it with a new token |
| Server shows **No audio** (detected by the server) | That server cannot fetch station sources while others can: outbound firewall, routing or DNS on that machine, or sources blocking its address | On that server: `docker compose logs slave_engine` shows which source failed and why. Fix the cause; it returns by itself within about 10 seconds |
| Server shows **No audio** (set by an administrator) | Marked through the dashboard or API | Servers > Back to automatic, or `PUT /servers/{id}/audio-status` with `{"status": "auto"}` |
| A station shows **No audio on <server>** | That one server cannot get audio from that station's sources; other servers are playing it | Hover the status for the reason. Usually the source blocks or limits that server's address, or that server cannot resolve or route to it. Listeners are unaffected meanwhile |
| A station shows **Source offline** | No server can get audio from its sources | The station's encoder or streaming server is down; see "A station will not play" above |
| A station that came back still returns `502` for a few seconds | Servers retry a silent station every 30 seconds, when a listener asks | Wait, or lower `STATION_RETRY_SECS` |
| Slave log: `Redis not reachable yet` after joining, with HTTPS handled in front of the master | Slaves are trying the domain, which points at the proxy | Set `CLUSTER_HOST` on the master to its direct address, `docker compose up -d`, and re-join the slave |
| Slave joined but stays **Unreachable** | The master cannot reach the address the slave joined from (NAT, firewall) | Open port 3000 to the master, or re-join with `--advertise <reachable address>` |
| Slave log: `Redis not reachable yet` | Port 6380 on the master is closed to it, or `CLUSTER_BIND` is still `127.0.0.1` | Open the port; on a `both` install set `CLUSTER_BIND=0.0.0.0` and `docker compose up -d` |
| All slaves **Unreachable** after changing `.env` on the master | `REDIS_PASSWORD` or `ENGINE_SECRET` changed | Re-join each slave with a new token |
| Opening a slave's address in a browser shows `Listeners connect through the gateway` | Working as intended | Use the master's domain |
| No servers listed and every stream returns `503` | A `master` install with no slave yet, or all engines down | Add a slave node; check `docker compose ps` on each server |
| Listeners are not spread evenly right after adding a server | Only new listeners are balanced; existing ones stay put | Evens out as listeners come and go |
| Server stays **Pending** | The admin service cannot reach HAProxy's runtime API | `docker compose logs admin_dashboard` and look for `[haproxy]` |

### Edge servers

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard or API returns `503` through an edge server | It cannot reach the master's relay port | Check `GATEWAY_PRIVATE_HOST`, `RELAY_BIND` on the master, and the firewall for port 8444 |
| Certificate warning on some connections only | An edge server has an old or different certificate | Run `edge/sync-cert.sh` on it and check its cron job |
| Edge server shows **Not reporting** | Its engine is down, cannot reach Redis, or its `NODE_ID` differs from its name in the Servers list | `docker compose logs audio_engine` in `edge/`; make the names match |
| Some listeners cannot connect after a server failed | Its address is still in DNS | Remove its A record |

## Certificates and HTTPS

| Symptom | Cause | Fix |
|---|---|---|
| Cannot reach the gateway by its IP address from another device | A firewall on the server or network, or the device is on another network | Allow port 80 on the server's firewall (`sudo ufw allow 80/tcp`); check both devices are on the same network |
| `https://<ip>` shows a certificate warning | The certificate is issued for the domain, not the address | Use `http://<ip>`, or the domain |
| Dashboard opened by IP shows stream URLs with the IP | Intended: URLs follow the address you are using | Open the dashboard by the domain to see the public URLs |
| Dashboard redirects in a loop behind a proxy | The proxy talks plain HTTP to the gateway, which redirects to HTTPS | Install with `--tls external` (sets `TLS_MODE=external`) |
| Stream URLs in the API start with `http://` behind a proxy | Same | Same, and set `PUBLIC_BASE_URL=https://<domain>` |
| Every client appears with the proxy's address; API rate limit hits everyone | The proxy does not send `X-Forwarded-For`, or `TLS_MODE` is not `external` | Fix either |
| `No private key found` from the installer | The key is in a separate file | Add `--key FILE` |
| Certificate works in browsers but a slave refuses the master | The chain file lacks the intermediate certificates | Use the full chain as `--cert` |

## Start-up problems

| Symptom | Cause | Fix |
|---|---|---|
| `haproxy_edge` keeps restarting | `certs/stream.pem` missing or malformed, or a syntax error in `haproxy.cfg` | `docker compose logs haproxy_edge`; the file must contain the certificate chain followed by the private key |
| `port is already allocated` | Another web server uses 80 or 443 | Stop it, or set `HTTP_PORT` / `HTTPS_PORT` |
| `admin_dashboard` exits with `password authentication failed` | `POSTGRES_PASSWORD` in `.env` differs from the one the database was created with | Restore the original value, or follow [Rotating credentials](OPERATIONS.md#rotating-credentials) |
| `ADMIN_API_KEY ignored` in the admin log | The key does not start with `rgw_` or is shorter than 36 characters | Generate one: `echo rgw_$(openssl rand -hex 24)` |
| `The prebuilt images could not be downloaded` | Nothing published yet, a private registry, or no route to it | See the reason printed beneath. For a private repository run `docker login ghcr.io` first. If CI has published the images but they are not public, make the packages public on GitHub (Packages > package settings > Change visibility) |
| `manifest unknown` | That tag does not exist | Check `IMAGE_TAG` in `.env` against the tags published under the repository's Packages |
| `no matching manifest for linux/...` | No image for this server's processor type | Use `./install.sh --build-from-source` |
| Engine image fails to build from source | Not enough memory during compilation | Use the prebuilt images, or add swap; compiling needs about 2 GB |
| New code but old behaviour after `git pull` | The images were not refreshed | Run `./install.sh`, which downloads the newest images for your tag |
| Let's Encrypt fails | DNS not pointing at the server yet, or port 80 blocked | Fix and re-run `./scripts/letsencrypt.sh issue` |

## Collecting information for support

```bash
docker compose ps
docker compose logs --since 30m > gateway-logs.txt
curl -s https://stream.example.com/api/v1/health
```

Remove API keys and passwords before sharing logs or `.env`.
