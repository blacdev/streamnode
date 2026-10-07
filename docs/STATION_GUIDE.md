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
| Listening address | No: one is made for you | `power-beats-fm-7k2q` |
| Stream address (primary) | Yes | `https://encoder.example.com/live` |
| Backup stream address | No | `https://backup.example.com/live` |
| Title address | No | `https://example.com/nowplaying.json` |
| Artwork address | No | `https://example.com/logo.png` |
| Your station's own title, artist and image | No | `More music, less talk`, `Power Beats FM`, your logo |

### Listening address

The address listeners tune in to is your gateway's address followed by the station's
own: `https://stream.example.com/power-beats-fm-7k2q`.

One is **made for you** when you add a station: your station's name in a form that fits
in an address, and four random characters that keep it unlike every other station's.
You may change it before saving to anything that is free; the form says at once
whether it is. Lower-case letters, digits, `-` and `_`, up to 50 characters.

Once the station is added the address stays as it is, because changing it would cut
off everyone tuned in and break every link already shared. An administrator can change
it if it has to be. Stations added before addresses were generated keep theirs.

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
| **HE-AAC / AAC+ / aacPlus** (`audio/aacp`, common at 32 to 64 kbps) | Yes | Yes | No: direct cuts | Yes |
| **Other audio** (Ogg Vorbis, Opus, FLAC, MPEG Layer II, AAC in LATM form) | Yes, exactly as it arrives | No | No | No |
| HLS (`.m3u8`), DASH, web pages with a player, streams that need a login | **No** | | | |

- **Silence detection** means a stream that stays connected but carries only silence,
  or only the hiss of an open input, is treated as down. The gateway listens to a
  small sample of the stream twice a second to tell. Every relayed type is still
  treated as down when it stops sending or disconnects.
- **HE-AAC** is recognised by listening to the stream; until a station has been on
  air, an AAC stream is taken to be HE-AAC when it is announced as `audio/aacp` or its
  frame headers state 24 kHz or less.
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

### Titles, artist and artwork

Listeners see the title, artist and artwork of **whatever is playing**. Each source
has its own:

| What is playing | Where its title and artist come from |
|---|---|
| Primary stream | The stream itself, or a title address if you give one |
| Backup stream | Its own stream. Or the same title address as the primary, if you say the backup plays the same programme |
| Fallback audio | Your station's own title and artist |
| Any of them, when it gives nothing | Your station's own title and artist |

The moment the station changes source, the previous source's title is dropped. Nothing
from a stream that has stopped stays on show.

#### 1. Titles in the stream (nothing to set up)

Your encoder or automation software embeds titles in the stream (its "metadata"
setting). The gateway passes them on. A title written as `Artist - Title` is split at
the first ` - ` into artist and title; a title without one is shown whole.

#### 2. A title address (optional)

If you would rather supply titles yourself, or want artwork that changes with each
song, give a web address that returns what is playing. While it answers it is used
instead of the titles in the stream. The gateway fetches it every 10 seconds while you
have listeners.

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

Plain text is read like a title in the stream: `Artist - Title` is split in two.

If the address stops answering, the titles in the stream are used until it recovers.

#### 3. The backup stream

A backup can be a copy of your primary, or a different programme altogether.

- **Different programme (the usual setting):** while the backup plays, listeners see
  the titles inside the backup's own stream. The primary's title address is not
  consulted, since it describes something that is not on air.
- **Same programme:** tick *The backup plays the same programme as the primary*. The
  title address is then used for the backup too.

The choice only matters when the station has both a backup and a title address.

#### 4. Your station's own title, artist and image (optional)

What listeners see when nothing above gives an answer:

| Setting | Example |
|---|---|
| Title | `More music, less talk` |
| Artist | `Power Beats FM` |
| Image | An uploaded JPEG, PNG, WebP or GIF, up to 5 MB; a square works best |

They are shown:

- while the **fallback audio** plays (in place of the file's name);
- when the playing source gives **no title**;
- when the title address **stops answering** and the stream has no title of its own;
- when there is **no artwork**, or an artwork address **does not work**.

The image is uploaded into your storage, like your audio files, and counts toward the
same quota. One image can serve several stations. It is also available at a public
address, `/api/v1/public/stations/<slug>/artwork`, which you may use on your website.

#### Artwork

Artwork is chosen in this order, using the first that works:

1. the artwork the title address gives for the current song;
2. your **artwork address**: a fixed picture, such as your logo (a square of at least
   500 by 500 pixels, served over `https`);
3. your uploaded **image**.

The gateway tries each address itself before showing it. One that cannot be reached,
or that answers with something other than a picture, is passed over, tried again every
minute, and used again as soon as it works.

#### Checking it

- The **Test** button beside each stream and the title address shows what the gateway
  reads from it right now, before you save.
- In the station list, each title says where it came from: *From the title address*,
  *From the stream*, *The station's own*, or *The fallback file's name*.

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

**Duplicate**, beside a station's Stats button, opens the Add station form filled in
with that station's settings: its streams, titles and artwork, and what happens when
audio stops. Give it a name, change what differs, and save. The name, the listening
address and the plan are not copied, and nothing is added until you save. This is the
quick way to offer the same stream as a second station.

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
listening at the moment (titles are only tracked while there are listeners). Give the
station a title and artist of its own and they are shown in both cases.
