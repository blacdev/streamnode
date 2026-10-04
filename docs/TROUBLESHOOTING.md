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
address with the User-Agent `StreamNode/1.0` (configurable with
`UPSTREAM_USER_AGENT`).

## Audio problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Playback cuts out every few minutes | A proxy or CDN in front of the gateway | Point DNS directly at the server; see [Installation](INSTALLATION.md#dns-do-not-proxy-the-hostname) |
| Short gap, then audio continues | Failover between primary and backup. The log shows `no audio from the source for the failover delay` or `live stream lost` | Expected. Investigate the station's primary source if frequent |
| The station switches to its backup or fallback although the stream is up | The stream is silent, or quieter than the silence threshold (-55 dB unless `SILENCE_THRESHOLD_DB` was changed), which counts as no audio | Fix the feed into the encoder, or switch silence detection off for the station |
| The dashboard shows a station's stream as "relayed as it is", and idents or fallback audio are refused | The stream is not MP3 or AAC (ADTS), or its content does not match its label (MPEG Layer II sent as `audio/mpeg`, say), or it changed format while playing. The engine log says `the stream is not made of MP3 or AAC (ADTS) frames` | Expected for those formats: the stream is still relayed. For the other features, have the station send MP3 or AAC. See [Supported stream types](STATION_GUIDE.md#supported-stream-types) |
| The station does not switch although nothing can be heard | The stream carries noise louder than the silence threshold (a loud hum, say), or silence detection is switched off for the station | Fix the source, or raise `SILENCE_THRESHOLD_DB` (for example to `-45`) on the streaming servers |
| Ident or fallback file is not played; log says `skipped: its format differs from the stream's` | The file was uploaded before the station's format was known, or the stream's format has changed since | Upload a file in the stream's format (shown in the station's edit form) |
| Log says `fallback file could not be opened` or `the ident could not be loaded` | The streaming server cannot reach the master's API, or the file is no longer stored | From that server, check the master's address answers `/api/v1/health`; upload the file again if it is missing |
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

## Uploading audio

| Symptom | Likely cause | Fix |
|---|---|---|
| "cannot be played on this station as it is ..." | The file's format, bitrate, sample rate or channels differ from the stream's | Agree to have it converted (tick *Convert*, or `convert=true`), or export it with the settings named in the message. See [Failover, idents and fallback audio](FAILOVER.md) |
| "This is a WAV file" (or M4A, FLAC, Ogg) with no offer to convert | It was uploaded without a station, or the station has never been on air, so there is no format to convert it to | Upload it from the station's edit form after the station has played once |
| A file stays *Converting* | Conversions run one at a time; a long file ahead of it is still being done. After a restart they are taken up again | Wait. `docker compose logs admin_dashboard` shows `conversion of file N failed` if one went wrong |
| *Could not be converted* | The reason is shown with the file: unreadable audio, or the result did not fit the storage quota | Delete it and upload it again, or raise the quota |
| A converted ident or fallback file is louder or quieter than the stream | It was converted before the stream's level was known (the station had been on air for under 20 seconds), or the stream's loudness has changed since | Delete the file and upload it again while the station is on air |
| "only ... of storage is free" | The account's quota is used up | Delete files, or raise the quota under Accounts > Storage |
| A large upload fails at once with `413` and no message from the gateway | A proxy in front of the gateway limits upload size | Raise it there, e.g. `client_max_body_size 0;` in nginx or the Advanced tab of Nginx Proxy Manager |
| Dropbox says the redirect URI is not allowed | The address under Settings > Dropbox storage is not among the app's Redirect URIs, or the dashboard was opened by IP address or over HTTP | Add exactly that address in the Dropbox developer console, and connect while using the dashboard by its HTTPS domain |
| Files stay "This server" after Dropbox is connected | Copying failed; the admin log says `was not copied to Dropbox` with the reason | Fix the cause (app permissions `files.content.write`, a full Dropbox); copying is retried every 5 minutes |

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
| Cannot reach the gateway by its IP address from another device | Wrong port, a firewall outside the server, or the device is on another network | Use the gateway's HTTP port (`HTTP_PORT` in `.env`; with a proxy on the same machine it is not 80). Docker opens published ports through `ufw`/`firewalld` by itself, so look at the hosting provider's firewall or the router instead. Check with `curl http://127.0.0.1:<port>/api/v1/health` on the server: `200` there means the gateway is fine and something in between is blocking |
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
| `update.sh`: images are not published yet | CI is still building the images for the newest commit, or that build failed | Wait a few minutes and run it again; if it persists, look at the Images workflow under the repository's Actions tab |
| Updates tab: "The update scheduler is not running" | cron is missing or not running on the server, or the entry was removed | Install cron, then `./scripts/update.sh schedule install` in the installation directory |
| Updates tab: settings cannot be saved | The `control/` directory is missing or not writable by the services | Run `./install.sh` on the server; it recreates it |
| "Install now" pressed but nothing happens | It starts on the scheduler's next pass, up to 5 minutes later | Watch the status line on the Updates tab; details are in `update.log` on the server |
| A slave stays on an older version than its master | The slave's scheduler is not running, or `UPDATE_FOLLOW_MASTER=false` | `./scripts/update.sh auto status` on the slave |
| Dashboard never shows an update notice | `UPDATE_REPO` is empty, the server cannot reach `api.github.com`, or the images were built from source | `GET /api/v1/system/version?refresh` shows the reason in `error` |
| Automatic updates do not run | The scheduler is not installed, or the chosen time is later than you think (it is on the server's clock) | The Updates tab shows both; `./scripts/update.sh auto status` on the server |
| `--build-from-source` fails with "source code is not on this server" | Installed without the source and its origin is unknown | Run the one-line install command with `--with-source` |
| Let's Encrypt fails | DNS not pointing at the server yet, or port 80 blocked | Fix and re-run `./scripts/letsencrypt.sh issue` |

## Collecting information for support

```bash
docker compose ps
docker compose logs --since 30m > gateway-logs.txt
curl -s https://stream.example.com/api/v1/health
```

Remove API keys and passwords before sharing logs or `.env`.
