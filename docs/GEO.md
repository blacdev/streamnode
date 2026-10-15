# Listener countries and devices

StreamNode can record **which countries and devices** listeners use, and let each
station decide **which countries may tune in**. Both are off by default; a server
without them behaves exactly as before.

## Switching it on

On the master server, in `.env`:

```
GEO_ENABLED=true
```

then `docker compose up -d` (or `./scripts/update.sh`). The installer and the
updater create `./geo` with empty map files, which HAProxy needs to start.

With `GEO_ENABLED=true`:

1. The dashboard service downloads the country database every month and loads it
   into HAProxy. The default source is DB-IP's free **IP to Country Lite**
   (`https://download.db-ip.com/free/dbip-country-lite-{YYYY}-{MM}.csv.gz`),
   licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):
   wherever countries are shown, say **"IP geolocation by DB-IP"** with a link to
   https://db-ip.com (the dashboard does). Any CSV of `start,end,country` (two-letter
   codes, IPv4 or IPv6, optionally gzipped) can be used instead: set
   `geo_database_url` in Settings (`PUT /api/v1/settings`). `POST /api/v1/geo/refresh`
   loads it now; `GET /api/v1/geo` shows what is loaded.
2. HAProxy looks up the country of every listener's address. An address the
   database does not cover counts as `ZZ` (unknown).
3. When a listening session ends, HAProxy sends one log line to the dashboard
   service (UDP 5140, inside the Docker network). Sessions and listening time are
   added up per station, UTC day, country and device (`station_audience_daily`).
   Refused listeners are not counted.

## Country rules per station

| Field | Values |
|---|---|
| `geo_mode` | `off` (everywhere, the default), `block` (everywhere except `geo_countries`), `allow` (only `geo_countries`) |
| `geo_countries` | Two-letter codes, for example `["NG", "GH"]` |

A refused listener gets **HTTP 451** "This station is not available in your
country." The rule applies to the stream and its `.m3u` / `.pls` playlists.

The station's `geo_status` says whether the rule is in force: `active`, `off`, or
`inactive: ...` with the reason. An `allow` rule waits until the country database
is loaded: before that every listener would count as unknown and be refused.

Rules take effect at once (HAProxy's maps are changed through its runtime API)
and are kept in `./geo`, so they survive a restart of HAProxy.

## Devices

Worked out from the player's User-Agent: `mobile`, `tablet`, `desktop`,
`smart speaker`, `tv`, `car`, `player app` (VLC, Winamp, foobar2000, apps built on
FFmpeg and the like), `other` or `unknown`.

## API

- `GET /api/v1/stations/{slug}/audience?from=YYYY-MM-DD&to=YYYY-MM-DD`: per day,
  `country` and `device`, each `{ key: { sessions, listener_hours } }`. `enabled`
  says whether this server records them.
- `GET /api/v1/capabilities` lists `listener_audience` and `geo_blocking` when
  `GEO_ENABLED=true`.

## Limits

- Rules and recording happen in the **master's HAProxy**. Listeners served through
  optional edge servers (`edge/`) are neither counted by country nor refused.
- A country database places addresses, not people: VPNs, proxies and mobile
  carriers' gateways can put a listener in another country. Country rules help
  meet licence territories; they are not a guarantee.
