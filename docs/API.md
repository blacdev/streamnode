# API guide

A practical guide to the management API. The complete, interactive reference for
every endpoint and field is served by the gateway at **`/api/v1/docs`** (raw OpenAPI
at `/api/v1/openapi.json`).

Examples assume:

```bash
API=https://stream.example.com/api/v1
KEY=rgw_...          # an API key
```

## Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://<your-domain>/api/v1` |
| Format | JSON in and out. Send `Content-Type: application/json` with bodies |
| Authentication | `X-API-Key: <key>` or `Authorization: Bearer <key>` |
| Times | ISO 8601 in UTC, e.g. `2026-03-01T14:00:00.000Z` |
| Dates | `YYYY-MM-DD`, UTC days |
| Sizes | Bytes, as integers |
| Rate limit | 300 requests per 10 seconds per client address; `429` beyond that |
| Request tracing | Every response carries `X-Request-Id`; send your own to have it echoed |

### Errors

```json
{
  "error": {
    "code": "validation_failed",
    "message": "One or more fields are invalid.",
    "details": [{ "field": "primary_url", "message": "must use http or https" }]
  }
}
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed request |
| 401 | `unauthorized` | Missing or invalid credentials |
| 403 | `forbidden` | Valid credentials, not permitted |
| 404 | `not_found` | Does not exist, or belongs to another tenant |
| 409 | `slug_taken`, `user_exists`, `self_lockout` | Conflict with existing data |
| 422 | `validation_failed` | Invalid fields, listed in `details` |
| 429 | `too_many_attempts` | Sign-in limiter |
| 500 | `internal_error` | Unexpected; includes `request_id` to quote in a report |

## Authentication and roles

Keys belong to accounts. An **administrator** key manages everything. A **tenant**
key covers every station that tenant owns: one account, and one key, can create and
run several stations (up to the account's `max_stations`, 5 by default), edit and
delete them, and read their statistics and combined usage.

The installer creates one administrator key (`ADMIN_API_KEY` in `.env`). Create
separate keys for each integration so they can be revoked individually:

```bash
curl -X POST $API/api-keys -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"name": "billing module"}'
```

```json
{ "id": 3, "user_id": 1, "name": "billing module", "key_prefix": "rgw_8c1f02ab", "key": "rgw_8c1f02ab...", "created_at": "..." }
```

The `key` value is returned only in this response.

## Stations

### Create or update (idempotent)

`PUT /stations/{slug}` creates the station if the slug is free and otherwise updates
the fields you send, leaving the rest unchanged. Repeating the call is harmless, which
makes it the right call for automated provisioning.

```bash
curl -X PUT $API/stations/powerbeats -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{
  "name": "Power Beats FM",
  "primary_url": "https://encoder.example.com/live",
  "backup_url": "https://backup.example.com/live",
  "metadata_url": "https://example.com/nowplaying.json",
  "artwork_url": "https://example.com/logo.png",
  "max_listeners": 500,
  "external_id": "service-1042"
}'
```

| Field | Required | Notes |
|---|---|---|
| `name` | On create | Shown to listeners as the station name when the source supplies none |
| `primary_url` | On create | The station's stream. `http` or `https`, public host |
| `backup_url` | No | Failover source. Same codec as the primary |
| `metadata_url` | No | Endpoint for title, artist and artwork; see the [Station guide](STATION_GUIDE.md#titles-artist-and-artwork). Used while the primary plays |
| `backup_titles_from_primary` | No | `true` when the backup carries the same programme, so `metadata_url` describes it too. Default `false`: the backup shows the titles in its own stream |
| `artwork_url` | No | Station artwork, used when the metadata URL gives none |
| `default_title`, `default_artist` | No | Up to 200 characters each. Shown when the stream and the metadata URL name nothing, when the metadata URL stops answering, and while the fallback file plays |
| `artwork_file_id` | No | An uploaded image from the station's account, used when there is no other artwork or `artwork_url` does not answer with a picture. The response gives its public address as `default_artwork_url` |
| `max_listeners` | No | Administrators only. `0` (default) is unlimited |
| `external_id` | No | Administrators only. Your identifier for the station |
| `failover_delay_secs` | No | Seconds without audio before moving to the next source. 1 to 300, default 6. Returning to a stream that is back is immediate |
| `silence_detection` | No | `true` (default) treats a stream that sends only silence as having no audio |
| `noise_detection` | No | `true` (default) treats a stream that sends nothing but hiss or other steady noise, however loud, as having no audio |
| `silence_threshold_db` | No | How quiet counts as silent for this station, -90 to -10. `null` (default) uses the server's setting, -55 |
| `ident_file_id` | No | An [uploaded file](#audio-files) played once at every change of source: on leaving a failed stream and on returning to one that is back. `null` clears |
| `fallback_file_id` | No | An uploaded file looped while neither stream has audio. `null` clears |
| `user_id` | No | Administrators only. Owning account; defaults to the caller |
| `is_active` | No | Administrators only. `false` suspends |

Slugs are 1 to 50 characters of `a-z`, `0-9`, `-` and `_`, starting and ending with
a letter or digit. `admin`, `api`, `healthz`, `health`, `metrics`, `status`,
`static`, `assets`, `docs`, `favicon`, `robots` and `index` are reserved.

The response is the station:

```json
{
  "id": 7,
  "slug": "powerbeats",
  "name": "Power Beats FM",
  "user_id": 1,
  "external_id": "service-1042",
  "primary_url": "https://encoder.example.com/live",
  "backup_url": "https://backup.example.com/live",
  "metadata_url": "https://example.com/nowplaying.json",
  "artwork_url": "https://example.com/logo.png",
  "max_listeners": 500,
  "is_active": true,
  "failover_delay_secs": 6,
  "silence_detection": true,
  "ident_file_id": 3,
  "fallback_file_id": 4,
  "stream_url": "https://stream.example.com/powerbeats",
  "playlist_urls": {
    "m3u": "https://stream.example.com/powerbeats.m3u",
    "pls": "https://stream.example.com/powerbeats.pls"
  },
  "live": {
    "online": true, "listeners": 42, "source": "primary",
    "title": "Blue in Green", "artist": "Miles Davis", "artwork": "https://example.com/art/kob.jpg",
    "title_from": "stream",
    "content_type": "audio/mpeg", "bitrate": 96, "connected_since": "2026-03-01T13:02:11.000Z"
  },
  "created_at": "...", "updated_at": "..."
}
```

`live.online` is `true` while the gateway is connected to the station's source, which
happens only while the station has listeners. A station with nobody listening is on
standby, not broken.

`live.source` is `primary`, `backup`, or `fallback` while the station is playing its
fallback file because neither stream has audio.

`live.stream_format` says what the stream was last seen to be and what the gateway can
do with it. It is `null` until the station has been on air.

```json
"stream_format": {
  "type": "mp3", "name": "MP3", "summary": "MP3, 96 kbps, 44.1 kHz, stereo",
  "codec": "mp3", "sample_rate": 44100, "channels": 2, "bitrate_kbps": 96, "variable_bitrate": false,
  "content_type": "audio/mpeg",
  "features": { "silence_detection": true, "fades": true, "idents": true, "fallback_audio": true },
  "notes": "Everything is available."
}
```

`type` is `mp3`, `aac`, `he-aac` or `other`. Uploaded files must match `codec`,
`sample_rate`, `channels` and, when it is not `null`, `bitrate_kbps`. With type `other`
the stream is relayed as it arrives and no file can be used on it. The full list of
types, readable without signing in:

```bash
curl $API/stream-types
```

Two more fields in `live` say when a station really is in trouble:

| Field | Meaning |
|---|---|
| `no_audio_on` | Servers that get no audio from this station's sources right now, each with `server`, `since` and `reason`. Such a server has released the station's listeners and resources; other servers keep playing it |
| `source_offline` | `true` when every server has found the sources silent: the station itself is off the air |

```json
"live": { "online": true, "listeners": 2, "servers": 1,
          "no_audio_on": [{ "server": "edge-2", "since": "2026-03-01T14:02:11.000Z", "reason": "primary: source answered HTTP 502" }],
          "source_offline": false }
```

### Other station calls

```bash
curl $API/stations -H "X-API-Key: $KEY"                          # list (limit, offset, q, user_id, external_id)
curl $API/stations/powerbeats -H "X-API-Key: $KEY"               # one station
curl -X PATCH $API/stations/powerbeats -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"backup_url": null}'  # change some fields; null clears
curl -X POST $API/stations/powerbeats/suspend -H "X-API-Key: $KEY"
curl -X POST $API/stations/powerbeats/unsuspend -H "X-API-Key: $KEY"
curl -X DELETE $API/stations/powerbeats -H "X-API-Key: $KEY"
```

- Edits to source URLs take effect within about 5 seconds. Listeners stay connected
  while the gateway reconnects to the new source.
- Suspending disconnects listeners within about 5 seconds; new connections get `503`.
  Configuration and history are kept.
- Deleting removes the station **and all of its statistics**. Read final usage first.
  Tenants can delete their own stations; suspending is administrator-only.

## Audio files

Idents and fallback audio. Background and the format rules are in
[Failover, idents and fallback audio](FAILOVER.md).

```bash
# Upload. The body is the file itself, not a form.
curl -H "X-API-Key: $KEY" --data-binary @ident.mp3 \
  "$API/files?filename=ident.mp3&name=Station%20ident&use=ident&station=powerbeats"

curl $API/files -H "X-API-Key: $KEY"                    # the library, with storage used and free
curl $API/files/3 -H "X-API-Key: $KEY"
curl -X PATCH $API/files/3 -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"name": "New ident"}'
curl -X DELETE "$API/files/3?force" -H "X-API-Key: $KEY"   # ?force also removes it from stations using it
curl -o copy.mp3 $API/files/3/content -H "X-API-Key: $KEY"
```

**Station images** go through the same endpoints and the same storage quota. A JPEG,
PNG, WebP or GIF is recognised by its content and stored with `kind: "image"` (its
`format` reads like `PNG image, 600 × 600`); `GET /files?kind=image` or `?kind=audio`
lists one kind only. An image may be at most 5 MB (`413 image_too_large`) and is never
converted.

```bash
# Upload a logo and make it the station's image in one call
curl -H "X-API-Key: $KEY" --data-binary @logo.png \
  "$API/files?filename=logo.png&use=artwork&station=powerbeats"

# Or choose one already in storage, and set the title and artist to fall back on
curl -X PATCH $API/stations/powerbeats -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"artwork_file_id": 7, "default_title": "More music, less talk", "default_artist": "Power Beats FM"}'

# Anyone can fetch it, from any site
curl -O https://stream.example.com/api/v1/public/stations/powerbeats/artwork
```

An image cannot be a station's ident or fallback, nor audio its image: both are
refused with `422` and a message saying so.

| Upload parameter | Notes |
|---|---|
| `filename` | The file's own name |
| `name` | Display name, also the title listeners see while a fallback file plays. Defaults to the file name without its extension |
| `use` | `ident` or `fallback`. With it, the file is checked for that use: an ident must not exceed the ident limit |
| `station` | A station slug (requires `use`). The file is checked against that station's stream and, if accepted, assigned to it |
| `assign` | `false` checks against `station` and stores the file without assigning it; set it later with `ident_file_id` or `fallback_file_id` |
| `user_id` | Administrators only: upload into another account |

```json
{
  "id": 3, "user_id": 4, "name": "Station ident", "original_name": "ident.mp3",
  "size_bytes": 24451, "format": "MP3, 96 kbps, 44.1 kHz, stereo",
  "codec": "mp3", "sample_rate": 44100, "channels": 2, "bitrate_kbps": 96, "constant_bitrate": true,
  "duration_seconds": 2.04, "stored_in": "local",
  "used_by": [{ "station": "powerbeats", "as": "ident" }],
  "usage": { "used_bytes": 24451, "quota_bytes": 524288000, "free_bytes": 524263549 }
}
```

Uploading a file the account already holds (the same bytes) stores nothing new: the
existing file is returned with `200` and `"already_stored": true`.

A file in the station's format is stored as it is. One in another format is converted
only when `convert=true` is passed, which is the caller's agreement that the file is
re-encoded to the stream's format, matched to the stream's loudness, and stored in
place of what was uploaded. The answer is then `202` with `"status": "converting"`;
the file can be assigned at once and plays when `status` becomes `ready` (poll
`GET /files/{id}`). `failed` comes with `status_detail`.

```bash
curl -H "X-API-Key: $KEY" --data-binary @mix.wav \
  "$API/files?filename=mix.wav&use=fallback&station=powerbeats&convert=true"

# A file already in the library, for a station it does not match:
curl -X POST $API/files/3/convert -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"station": "powerbeats", "use": "fallback"}'
```

`POST /files/{id}/convert` answers `202` with a new file, which takes the original's
place on that station when it is ready; the original is removed if nothing else uses
it. Each file reports `status`, `converted` and `gain_db` (how much it was turned up
or down to match the stream).

A file that cannot be used is refused, and the message says why and what to do:

| Status | `code` | When |
|---|---|---|
| `422` | `conversion_needed` | The file is not in the station's format and `convert=true` was not passed. `details.can_convert` is `true` and `details.target` names the format |
| `422` | `file_not_usable` | Not audio; an ident longer than the limit; another format with no station to convert it for, or for a station whose format is not yet known or cannot be produced (HE-AAC) |
| `413` | `quota_exceeded` | The file does not fit in the account's remaining storage. `details` has `file_bytes`, `used_bytes`, `quota_bytes`, `free_bytes` |
| `507` | `server_storage_full` | The server's own disk is full |
| `409` | `file_in_use` | Deleting a file a station still uses, without `?force` |

The same checks apply when a file is assigned with `ident_file_id` or
`fallback_file_id` on a station; a mismatch is a `422` naming the field, with
`can_convert: true` and the `file_id` when `POST /files/{id}/convert` would resolve it.

### Settings and storage (administrators)

```bash
curl $API/settings -H "X-API-Key: $KEY"
curl -X PUT $API/settings -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"ident_max_seconds": 5, "default_storage_quota_mb": 2048}'
curl -X PATCH $API/users/4 -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"storage_quota_mb": 4096}'                        # one account; null returns it to the default

# Dropbox: save the app's key and secret, then open authorize_url in a browser.
curl -X PUT $API/settings -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"dropbox_app_key": "...", "dropbox_app_secret": "..."}'
curl -X POST $API/storage/dropbox/authorize -H "X-API-Key: $KEY"
curl -X DELETE $API/storage/dropbox -H "X-API-Key: $KEY"   # copies every file back first
```

`GET /auth/me` includes the caller's `storage` (`used_bytes`, `quota_bytes`,
`free_bytes`), and `GET /users` includes each account's `storage_quota_mb` and
`storage_used_bytes`.

## Live state

```bash
curl $API/stations/powerbeats/status -H "X-API-Key: $KEY"
curl $API/overview -H "X-API-Key: $KEY"
curl $API/metrics -H "X-API-Key: $KEY"
```

`/status` returns the `live` object for one station, refreshed every 2 seconds.
`/overview` returns totals across the stations the key can see. `/metrics` returns
all-time bytes and current listeners for every station.

## History

```bash
curl "$API/stations/powerbeats/stats?from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z&interval=hour" \
  -H "X-API-Key: $KEY"
```

```json
{
  "station": "powerbeats",
  "from": "2026-03-01T00:00:00.000Z", "to": "2026-03-02T00:00:00.000Z",
  "interval": "hour",
  "totals": { "bytes": 18230412800, "peak_listeners": 97, "listener_hours": 421.7, "sessions": 3110 },
  "points": [
    { "t": "2026-03-01T06:00:00.000Z", "bytes": 512001024, "peak_listeners": 31, "avg_listeners": 24.6, "listener_hours": 24.6, "sessions": 140 }
  ]
}
```

| Parameter | Default | Notes |
|---|---|---|
| `from`, `to` | The last 24 hours | ISO 8601 or Unix seconds |
| `interval` | `minute` up to 6 h, `hour` up to 14 days, `day` beyond | At most 5,000 buckets per request |

Buckets with no activity are omitted; treat a missing bucket as zero. Minute and hour
resolution are available for 90 days (configurable); day resolution is permanent.

## Usage for billing

```bash
curl "$API/usage?from=2026-03-01&to=2026-03-31" -H "X-API-Key: $KEY"
```

```json
{
  "from": "2026-03-01", "to": "2026-03-31",
  "totals": { "bytes": 912345678901, "gigabytes": 912.346, "listener_hours": 21044.5, "sessions": 150233 },
  "stations": [
    { "station": "powerbeats", "name": "Power Beats FM", "user_id": 4, "external_id": "service-1042",
      "bytes": 512345678901, "gigabytes": 512.346, "peak_listeners": 311, "listener_hours": 11876.2, "sessions": 80211 }
  ]
}
```

Both dates are inclusive UTC days and default to the current month to date.
`gigabytes` is bytes divided by 1,000,000,000. Use `/stations/{slug}/usage` for one
station.

## Accounts

Administrators only.

```bash
curl -X POST $API/users -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"username": "client-311", "external_id": "client-311", "max_stations": 0}'
curl "$API/users?external_id=client-311" -H "X-API-Key: $KEY"
curl -X PATCH $API/users/4 -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"is_active": false}'
curl -X DELETE $API/users/4 -H "X-API-Key: $KEY"
```

| Field | Notes |
|---|---|
| `password` | Optional. Only needed if the account signs in to the dashboard. Minimum 10 characters |
| `external_id` | Your identifier for the customer. Unique |
| `storage_quota_mb` | Megabytes of uploaded audio the account may hold. `null` (the default) uses the gateway-wide setting |
| `email` | Optional. Where notices about limits and subscriptions go. The account's owner can also set it (`PATCH /auth/me`) |
| `discount_percent` | Taken off the account's monthly total |
| `max_stations` | How many stations the account may create and manage. Defaults to 5 (`DEFAULT_MAX_STATIONS`). `0` means stations are created by an administrator only |
| `is_active` | `false` blocks the account's keys and sign-in. It does **not** stop its stations; suspend those separately |

Deleting an account deletes its stations, keys, statistics and uploaded files.

## Billing, limits and capacity

Prices per station and account, each station against its limits, the add-a-server
calculator and email notices are described, with their calls, in
[Costs, capacity, billing and limits](BILLING.md). In short:

```bash
curl $API/billing -H "X-API-Key: $KEY"                         # the account's bill (a tenant sees only their own)
curl $API/stations/powerbeats/limits -H "X-API-Key: $KEY"      # one station against its limits
curl "$API/billing/quote?listeners=500&bitrate_kbps=128&storage_mb=2048" -H "X-API-Key: $KEY"
curl $API/billing/rates -H "X-API-Key: $KEY"                   # administrators: the rate card
curl -X POST $API/capacity/estimate -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"vcpus": 4, "memory_gb": 8, "port_mbps": 1000, "mode": "proxied"}'
```

A station's listener limit, the bitrate it is charged at, its discount, a fixed price,
its subscription date and the account it belongs to are fields of the station
(`max_listeners`, `billing_bitrate_kbps`, `discount_percent`, `price_override`,
`subscription_ends_on`, `user_id`) that only an administrator can set.

## Servers

Administrators only. See [Adding servers](SCALING.md).

**Create the install command for a new slave node:**

```bash
curl -X POST $API/cluster/join-tokens -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"note": "rack 2", "expires_minutes": 60, "max_uses": 1}'
```

```json
{
  "id": 4, "token_prefix": "rgj_4be1a09c", "expires_at": "2026-03-01T15:00:00.000Z", "max_uses": 1, "uses": 0,
  "token": "rgj_4be1a09c...",
  "master_url": "https://stream.example.com",
  "install_command": "curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash -s -- --role slave --master https://stream.example.com --token rgj_4be1a09c..."
}
```

The token is shown only here. `install_command` is for a new, empty server: it installs
what is needed and joins this master. `GET /cluster/join-tokens` lists tokens that are still
usable; `DELETE /cluster/join-tokens/{id}` revokes one.

**Or connect a slave that is installed and waiting,** using the values its installer
printed:

```bash
curl -X POST $API/servers -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"host": "203.0.113.20", "port": 3000, "setup_key": "rgn_..."}'
```

The response is the server as it joined, under the name it chose.

**Manage servers:**

```bash
curl $API/servers -H "X-API-Key: $KEY"
curl -X PATCH $API/servers/2 -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"weight": 200}'
curl -X PATCH $API/servers/2 -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"enabled": false}'   # drain
curl -X DELETE $API/servers/2 -H "X-API-Key: $KEY"
```

```json
{ "id": 2, "name": "edge-2", "mode": "proxied", "host": "203.0.113.20", "port": 3000, "weight": 100,
  "enabled": true, "is_builtin": false, "state": "UP", "connections": 412, "resources": { "...": "see Capacity" } }
```

`state` and `connections` are what the master's HAProxy reports. On writes, `applied`
is `false` if HAProxy could not be reached; the change is then applied automatically.

**Audio state.** Each server carries an `audio` object:

```json
"audio": { "status": "no_audio", "forced": false, "since": "2026-03-01T14:02:11.000Z",
           "reason": "cannot get audio from the source of jazz, which another server is playing" }
```

`status` is `ok` or `no_audio`. A server sets `no_audio` by itself when it gets no
audio at all and is failing on several stations that other servers can play, and
clears it when a source works again ([how it decides](SCALING.md#when-there-is-no-audio)).
One station failing on a server does not take the server out; that is reported per
station, in the station's `live.no_audio_on`. While it is set, no listeners
are sent to the server. You can set the same state yourself, for example from a
monitoring system:

```bash
# take the server out; its listeners reconnect to the other servers
curl -X PUT $API/servers/2/audio-status -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"status": "no_audio", "reason": "upstream network maintenance"}'
# hand the decision back to the server
curl -X PUT $API/servers/2/audio-status -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"status": "auto"}'
```

`forced` is `true` for a state set this way; it stays until you send `auto`.
`GET /capacity` lists servers with no audio under `reasons`.

`POST /cluster/join` is the call a slave's engine makes with its token. It is not
meant for people or integrations.

An optional [edge server](SCALING.md#edge-servers-optional) is listed with
`{"name": "edge-2", "host": "203.0.113.20", "mode": "direct"}`. For those, `state` is
`UP` while the engine is reporting, and weight and draining do not apply.

## Version and updates

Administrators only. These are what the dashboard's Updates tab uses.

```bash
curl $API/system/version -H "X-API-Key: $KEY"
```

```json
{ "enabled": true, "repository": "blacdev/streamnode", "branch": "main",
  "installed": "5f3d7b3c0d...", "latest": "9a1e44f2b7...", "update_available": true,
  "checked_at": "2026-03-01T14:00:00.000Z", "error": null,
  "settings": { "auto": true, "time": "04:15" },
  "updater": { "scheduler_running": true, "server_time": "14:05", "server_zone": "UTC",
               "state": "ok", "message": "Updated to 5f3d7b3 (scheduled).",
               "updated_at": "2026-03-01T04:16:10Z", "install_pending": false } }
```

```bash
# automatic updates, daily at 04:15 on the server's clock
curl -X PUT $API/system/update-settings -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"auto": true, "time": "04:15"}'
# install the latest version now (starts within 5 minutes)
curl -X POST $API/system/update -H "X-API-Key: $KEY"
```

| Field | Meaning |
|---|---|
| `update_available` | `null` when it cannot be told: images built from source, or GitHub not reachable |
| `settings.time` | Time of day on the server's own clock; `updater.server_time` shows what that clock reads |
| `updater.scheduler_running` | `false` means nothing is installed by itself: the scheduler is missing on the server |
| `updater.state` | `idle`, `running`, `waiting` (images still being built), `ok` or `failed`, with `message` |
| `updater.install_pending` | An "install now" request is waiting for the next scheduler pass |

The gateway checks its repository every 6 hours; add `?refresh` to check now.
`POST /system/update` answers `409` when already current and `503` when the scheduler
is not running. See [Updating](INSTALLATION.md#updating).

## Capacity: is another server needed?

Administrators only.

```bash
curl $API/capacity -H "X-API-Key: $KEY"
```

```json
{
  "status": "warning",
  "add_server_recommended": true,
  "reasons": ["local: memory at 91.2%"],
  "averages": { "cpu_percent": 41.3, "memory_percent": 78.4 },
  "thresholds": { "warning_percent": 75, "critical_percent": 90 },
  "totals": { "servers": 2, "servers_reporting": 2, "listeners": 5310, "network_out_bps": 84960000 },
  "database": { "size_bytes": 412345678 },
  "servers": [
    {
      "id": 1, "name": "local", "state": "UP", "connections": 2710, "enabled": true,
      "resources": {
        "status": "critical",
        "cpu": { "percent": 48.0, "cores": 4, "load_1m": 1.9, "status": "ok" },
        "memory": { "total_bytes": 8589934592, "used_bytes": 7834020348, "percent": 91.2, "status": "critical" },
        "disk": { "total_bytes": 85899345920, "used_bytes": 30064771072, "free_bytes": 55834574848, "percent": 35.0, "status": "ok" },
        "network_out_bps": 43360000, "listeners": 2710, "stations_on_air": 37,
        "uptime_seconds": 864000, "engine_version": "1.2.0", "reported_at": "2026-03-01T14:00:02.000Z"
      }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `status` | Worst level across reporting servers: `ok`, `warning` (75% or more) or `critical` (90% or more) |
| `add_server_recommended` | `true` when any enabled server is critical on CPU or memory, or the average CPU or memory across servers has reached the warning level |
| `reasons` | Plain-language list of what is high. A full disk is listed here but does not by itself recommend another server |
| `resources.cpu` / `memory` / `disk` | Whole-machine figures for the server the engine runs on, refreshed every 2 seconds |
| `resources.network_out_bps` | **Bytes** per second leaving the engine; multiply by 8 for bits |
| `resources` is `null` | The engine is not running or cannot reach Redis |
| `database.size_bytes` | Size of the PostgreSQL database on the gateway |

A monitoring job can poll this and alert on `add_server_recommended`.

## Trying an address before saving

`POST /probe` has a streaming server connect to a stream or a title address, through
the same checks as any source, and report what it reads. Nothing is saved.

```bash
curl -X POST $API/probe -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"kind": "stream", "url": "https://encoder.example.com/live"}'
```

```json
{ "ok": true, "content_type": "audio/mpeg", "format": "MP3 44100 Hz stereo", "bitrate_kbps": 96,
  "name": "Power Beats FM", "carries_titles": true, "artist": "Miles Davis", "title": "Blue in Green" }
```

With `"kind": "titles"` the answer is what was found at a title address:
`title`, `artist`, `artwork` and `artwork_works`. An address that cannot be used
answers `{"ok": false, "error": "..."}` with the reason. It takes up to about ten
seconds; `503 no_streaming_server` means no engine is running to try it with.

## Public endpoint: now playing

No authentication, callable from any web page:

```bash
curl https://stream.example.com/api/v1/public/stations/powerbeats/now-playing
```

```json
{
  "station": "powerbeats", "name": "Power Beats FM", "online": true,
  "title": "Blue in Green", "artist": "Miles Davis", "artwork": "https://example.com/art/kob.jpg",
  "stream_url": "https://stream.example.com/powerbeats",
  "playlist_urls": { "m3u": "https://stream.example.com/powerbeats.m3u", "pls": "https://stream.example.com/powerbeats.pls" }
}
```

`title_from` says where the title and artist come from: `metadata_url`, `stream`
(the playing stream, split at the first ` - ` into artist and title), `station` (the
station's own defaults) or `file` (the fallback file's name).

Responses may be cached for 5 seconds. `title`, `artist` and `artwork` are what is on
air; whatever is missing there (or everything, while nobody is listening) is filled
from the station's `default_title`, `default_artist` and uploaded image, and is `null`
only when the station has none.

`GET /api/v1/public/stations/{slug}/artwork` returns the station's uploaded image
itself (`404` when it has none). It may be embedded in any web page.

## Dashboard sessions

The dashboard signs in with a username and password and then uses the token like a key:

```bash
curl -X POST $API/auth/login -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "..."}'
# {"token": "rgs_...", "expires_in": 43200, "user": {...}}
curl $API/auth/me -H "Authorization: Bearer rgs_..."
```

Integrations should use API keys, not sessions.
