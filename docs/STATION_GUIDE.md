# Station guide

For station owners and the people who set stations up. It explains what the gateway
needs from you and what you get back.

## What the gateway does for your station

Your encoder or streaming server keeps working exactly as it does now. The gateway
connects to it **once** and rebroadcasts that stream to all of your listeners from
its own address. Your server carries the load of a single listener, however many
people tune in.

- Your audio is not altered. Format and bitrate go out as you send them.
- The gateway only connects to your server while someone is listening. With no
  listeners it disconnects, and reconnects when the next one arrives.
- You get listener counts, history and data usage.

## What to provide

| Item | Required | Example |
|---|---|---|
| Station name | Yes | `Power Beats FM` |
| Stream address (primary) | Yes | `https://encoder.example.com/live` |
| Backup stream address | No | `https://backup.example.com/live` |
| Title and artwork address | No | `https://example.com/nowplaying.json` |
| Station artwork address | No | `https://example.com/logo.png` |

### Stream address

The direct address of your MP3 or AAC stream from Icecast, SHOUTcast or a hosted
streaming provider. To check it, open it in VLC (*Media > Open Network Stream*): if
VLC plays it, the gateway can relay it.

| Works | Does not work |
|---|---|
| `http://server:8000/live` (Icecast mount) | A web page that contains a player |
| `http://server:8000/;` or `/stream` (SHOUTcast) | HLS addresses ending in `.m3u8` |
| `https://provider.example/yourstation.mp3` | Addresses that need a username and password |
| A `.m3u` or `.pls` playlist pointing at any of the above | Private or internal network addresses |

### Supported stream types

Every format in the first four rows is relayed unchanged. What differs is what the
gateway can add to it.

| Your stream | Relayed | Silence detection | Fades | Ident and fallback audio |
|---|---|---|---|---|
| **MP3** (Icecast, SHOUTcast or a hosted provider; any bitrate, constant or variable) | Yes | Yes | Yes | Yes |
| **AAC** (AAC-LC as ADTS, content type `audio/aac`) | Yes | Yes | No: direct cuts | Yes |
| **HE-AAC / AAC+ / aacPlus** (`audio/aacp`, common at 32 to 64 kbps) | Yes | No | No: direct cuts | Yes |
| **Other audio** (Ogg Vorbis, Opus, FLAC, MPEG Layer II, AAC in LATM form) | Yes, exactly as it arrives | No | No | No |
| HLS (`.m3u8`), DASH, web pages with a player, streams that need a login | **No** | | | |

- **Silence detection** means a stream that stays connected but carries only silence
  is treated as down. Every relayed type is still treated as down when it stops
  sending or disconnects.
- **HE-AAC** frames stay full even when they carry silence, so silence cannot be
  recognised without decoding. The gateway takes an AAC stream to be HE-AAC when it is
  announced as `audio/aacp` or its frame headers state 24 kHz or less.
- A stream whose content does not match its label, or that changes format while
  playing, is treated as "other audio" from that moment.

The type is detected the first time the station plays. From then on the dashboard
shows it under the station's name, with what is and is not available, and the API
reports it as `live.stream_format`. The same table is served at
`/api/v1/stream-types`.

### Backup stream

A second source that takes over automatically if your primary cannot be reached,
drops, or goes silent for 6 seconds (you can change the number). Listeners stay
connected. When your primary is healthy again the gateway switches back by itself.

Use the **same format and bitrate** as your primary. Different formats can make
players stutter or stop when the switch happens.

### Ident and fallback audio

You can upload a short **ident** that is played whenever the station has to switch
away from a failed stream, and a **fallback file** that plays in a loop if neither
stream has audio, so listeners are never left in silence. Files must be in exactly
the same format as your stream, because the gateway does not convert audio. See
[Failover, idents and fallback audio](FAILOVER.md).

### Song titles

By default the gateway passes on the titles your encoder embeds in the stream (the
"metadata" setting in your encoder or automation software). Nothing else is needed.

### Title and artwork URL

If you would rather supply titles yourself, or want artwork to change with each song,
give a web address that returns what is playing. The gateway fetches it every 10
seconds while you have listeners.

It can return **JSON** or **plain text**.

Simplest JSON:

```json
{
  "title": "Blue in Green",
  "artist": "Miles Davis",
  "artwork": "https://example.com/covers/kind-of-blue.jpg"
}
```

The gateway looks for these names anywhere in the JSON, so most existing now-playing
feeds work unchanged, including AzuraCast (`/api/nowplaying/<station>`) and Icecast
(`/status-json.xsl`).

| Information | Field names recognised |
|---|---|
| Title | `title`, `song`, `track`, `streamtitle`, `now_playing`, `nowplaying`, `text` |
| Artist | `artist`, `artist_name`, `performer` |
| Artwork | `artwork`, `artwork_url`, `art`, `cover`, `cover_url`, `coverart`, `image`, `image_url`, `thumb` |

Only `title` is required. If there is no separate artist, put both in the title as
`Artist - Title`. Artwork may be a full address or a path relative to the feed.

Plain text: the first line is used as the title.

```
Miles Davis - Blue in Green
```

If the address stops responding, the gateway goes back to the titles embedded in your
stream until it recovers.

### Station artwork

A fixed image (your logo) shown whenever no per-song artwork is available. Use a
square image of at least 500 by 500 pixels, served over `https`.

## What you get

| Item | Example |
|---|---|
| Stream address for listeners | `https://stream.example.com/powerbeats` |
| Playlist files | `https://stream.example.com/powerbeats.m3u` and `.pls` |
| Now-playing feed for your website | `https://stream.example.com/api/v1/public/stations/powerbeats/now-playing` |

Give listeners the gateway address, not your encoder's. See the
[Listener and player guide](PLAYERS.md) for which address to use where, and for a
web player you can paste into your site.

## Several stations on one account

One account can hold several stations. Sign in once and you see all of them, each
with its own stream address, settings and statistics. Use **Add station** to create
another; the line beside it shows how many your account allows. One API key works for
all of your stations.

## Your statistics

| Figure | Meaning |
|---|---|
| Listeners now | People connected at this moment |
| Peak listeners | The most connected at the same time in the period |
| Average listeners | Average number connected across the period |
| Listening hours | Total time everyone spent listening, added together |
| Connections | How many times a listener connected. One person reconnecting counts again |
| Data sent | The amount of audio data delivered to listeners |

"Standby" means nobody is listening right now, so the gateway is not connected to your
server. It is not a fault.

"Source offline" means the gateway tried your stream and backup and got no audio from
either. Check your encoder. Listeners get an immediate error rather than silence, and
the gateway tries again every 30 seconds while people keep trying to listen.

## Common questions

**Do I need to change my encoder?** No. Keep streaming to your existing server.

**Will the gateway change my sound quality?** No. It forwards the audio untouched.

**My own server shows only one listener.** That is the gateway. Your real audience
figures are in the gateway's statistics.

**I changed my stream address.** Update it in the station's settings. The gateway
switches within a few seconds and listeners stay connected.

**Why is the title blank?** Either your encoder is not sending titles, or nobody is
listening at the moment (titles are only tracked while there are listeners).
