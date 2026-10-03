# Failover, idents and fallback audio

What a station does when its stream stops, and how to set it up. For station owners
and operators.

## What happens when a stream stops

A station can have up to three things to play, tried in this order:

1. its **primary stream**
2. its **backup stream** (optional)
3. a **fallback file** you uploaded (optional), played in a loop

and an optional **ident**: a short clip, such as the station's jingle, played once
at every change: when the station moves on from a stream that failed, and when it
returns to a stream that is back.

```
primary stops or goes silent
        │  waits the failover delay (6 seconds unless changed), retrying the primary
        ▼
     ident                      (if the station has one)
        ▼
backup stream                   (if the station has one and it has audio)
        │  backup stops or goes silent: waits the failover delay, retrying it
        ▼
     ident
        ▼
fallback file, looping          (if the station has one)
        │
        ▼  the moment the primary, or else the backup, has audio again:
     ident, then the live stream
```

Listeners stay connected throughout, and players carry on without a reconnect.

### Returning to a live stream

The delay is only for leaving a stream. Coming back is immediate: a stream that is
down is tried again every 2 seconds, and once it has delivered one second of real
audio the station returns to it. How the change sounds depends on the station:

| The station has | What listeners hear |
|---|---|
| An ident | The ident, then the live stream |
| No ident, MP3 stream | What is playing fades out over half a second and the live stream fades in |
| No ident, AAC stream | A direct cut to the live stream |
| Nothing audible playing (silence) | The live stream starts at once, with no fade |

Fades are done without converting anything: each MP3 frame states its own volume, and
the gateway lowers that number step by step. AAC keeps its volume where only decoding
could reach it, so AAC stations get a direct cut; give them an ident for a smoother
change.

Every join is also made safe for players. An MP3 frame can depend on the frames before
it, so the first one or two frames of a stream that is being joined (about a twentieth
of a second) are sent as silence instead of being left to decode as a burst of noise. While the fallback file plays,
listeners see its name as the title and the dashboard shows the station as
**On air (fallback audio)**.

If a station has none of these left (no backup, no fallback file), it behaves as
before: listeners are released after a few failed attempts and the dashboard shows
**Source offline**.

### "No audio" means

- the stream cannot be reached, ends, or stops sending data; or
- the stream keeps sending but carries **silence** (for example the studio feed into
  the encoder was unplugged).

Silence is recognised from the audio frames themselves, without decoding them, so it
costs no measurable CPU. It catches true digital silence. A stream that carries
faint noise (an analogue input left open, a hiss) is not silence and does not
trigger a switch. Silence detection can be switched off per station, for stations
that broadcast silence on purpose.

### The failover delay

One number per station, 1 to 300 seconds, **6 by default**: how long a stream may be
without audio before the station moves on. It is there to be sure the stream is really
down. A stream that comes back within the delay is simply carried on with, and nothing
else happens. The delay does not apply to coming back, which is immediate.

A short delay reacts faster but moves on during brief network hiccups. A long delay
rides those out but leaves listeners in silence for longer.

## Files must match the stream exactly

**The gateway does not convert audio.** Idents and fallback files are sent to
listeners exactly as uploaded, spliced into the same connection as the live stream. A
player that is given a different format in mid-stream stutters, plays at the wrong
speed or stops. So a file must already be what the stream is:

| Must match | Example |
|---|---|
| Format | MP3 stream: MP3 file. AAC stream: AAC in an `.aac` (ADTS) file, not `.m4a` |
| Bitrate | 96 kbps stream: 96 kbps file. MP3 files must be **constant bitrate (CBR)** |
| Sample rate | 44.1 kHz stream: 44.1 kHz file |
| Channels | Stereo stream: stereo file |

The station's own format is shown next to the file choices in the dashboard once the
station has been on air, and in the API as `live.stream_format`.

A file that cannot be used is **refused, with the reason and what to do**:

> "night-mix" cannot be played on this station because its bitrate is 128 kbps and
> the stream's is 96 kbps. The gateway does not convert audio, so the file has to
> match the stream exactly: export it as MP3, 96 kbps constant bitrate, 44.1 kHz,
> stereo and upload it again.

| Refusal | What to do |
|---|---|
| WAV, FLAC, Ogg, M4A/MP4 | Export as MP3, or as AAC in an `.aac` file |
| Different bitrate, sample rate, or mono/stereo | Export with the settings named in the message |
| Variable bitrate MP3 | Export as constant bitrate (CBR) |
| Ident too long | Shorten it. The limit is 5 seconds unless the administrator changed it |
| Not enough storage | Delete files you no longer need, or ask the administrator for a larger quota |

Exporting with the free tool ffmpeg, for a 96 kbps stereo 44.1 kHz stream:

```bash
ffmpeg -i input.wav -c:a libmp3lame -b:a 96k -ar 44100 -ac 2 output.mp3          # MP3
ffmpeg -i input.wav -c:a aac -b:a 96k -ar 44100 -ac 2 -f adts output.aac         # AAC
```

Other points:

- Only **MP3 and AAC** stations (including HE-AAC) can use idents and fallback files,
  and silence is recognised on MP3 and plain AAC only. See
  [Supported stream types](STATION_GUIDE.md#supported-stream-types).
- For an **HE-AAC** station the file must be HE-AAC made with the same encoder
  settings. The gateway can compare what the frame headers state (sample rate,
  channels), not whether a file really is HE-AAC, so check such a file by ear.
- A **variable-bitrate MP3** stream has no single bitrate to match: any MP3 with its
  sample rate and channels is accepted.
- A station that has never been on air has no known format yet. Files are accepted
  and checked when first needed; one that turns out not to match is skipped (the
  server's log says so) rather than played.
- If you change your stream's format later, replace the files to match.
- A file's tags (title, cover art) are not sent to listeners; only its audio is.

## Setting it up

### In the dashboard

Your account has one storage space, shared by all of your stations.

1. **Stations > Edit**: set the seconds without audio before switching and whether
   silence counts. For the ident and the fallback audio, either choose a file that is
   already in your storage or upload a new one right there; an uploaded file goes into
   your storage and can be chosen for your other stations too.
2. **Audio files** tab: everything in your storage, how much of it is used, which
   stations use each file, and uploading, renaming and deleting.

Each station checks the file it is given against its own stream. A file that suits one
station may be refused on another with a different bitrate or format, and the message
says what that station needs. A fallback file can be of any length: a short loop or a
several-hour mix. Your storage quota is the only limit.

### With the API

```bash
# Upload: the request body is the file itself.
curl -H "X-API-Key: $KEY" --data-binary @night-mix.mp3 \
  "$API/files?filename=night-mix.mp3&name=Night%20mix&use=fallback&station=powerbeats"

curl -H "X-API-Key: $KEY" $API/files                       # library, storage used and free

# Station settings
curl -X PATCH $API/stations/powerbeats -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"failover_delay_secs": 6, "silence_detection": true, "ident_file_id": 3, "fallback_file_id": 4}'
```

See the [API guide](API.md#audio-files).

## Storage and quotas (administrators)

Each account may hold a set amount of uploaded audio. An upload that does not fit is
refused before it is stored: a 3 GB file into a 2 GB quota is not accepted until the
quota is raised.

| Setting | Where | Default |
|---|---|---|
| Storage for each account | Dashboard: Settings. API: `PUT /settings` `default_storage_quota_mb` | 500 MB |
| Storage for one account | Dashboard: Accounts > Storage. API: `PATCH /users/{id}` `storage_quota_mb` (`null` for the default) | the default |
| Longest ident | Dashboard: Settings. API: `PUT /settings` `ident_max_seconds` (1 to 30) | 5 seconds |

Administrator accounts are not limited. Idents count towards the quota like any other
file.

### Where files are kept

Without Dropbox, files are kept on the master server, in the `media_files` Docker
volume, and count against its disk.

With **Dropbox connected**, each file is copied to your Dropbox after it is uploaded
and Dropbox becomes its permanent home. The master keeps recently used files on its
own disk as well, up to `FILE_CACHE_MB` (2 GB by default), so that a file is at hand
the moment a station needs it; beyond that size, files no station uses are dropped
from the server first, then the least recently used, and fetched from Dropbox again
when needed. Streaming servers never store files: they fetch one from the master
when a station starts using it and read it as they play it.

### Connecting Dropbox

1. Go to <https://www.dropbox.com/developers/apps> and choose **Create app**:
   *Scoped access*, *App folder* (the gateway then sees only its own folder), any name.
2. On the app's **Permissions** tab tick `files.content.write` and
   `files.content.read`, and submit.
3. On the **Settings** tab, under *Redirect URIs*, add the address the dashboard shows
   under **Settings > Dropbox storage**. It looks like
   `https://stream.example.com/api/v1/storage/dropbox/callback`. Dropbox accepts only
   `https` addresses here, so the dashboard must be opened by its domain over HTTPS.
4. Copy the **App key** and **App secret** into the dashboard and press
   **Save and connect**. Dropbox asks you to allow the app, then returns you to the
   dashboard. Files already uploaded are copied over in the background.

The same with the API: `PUT /settings` with `dropbox_app_key` and
`dropbox_app_secret`, then `POST /storage/dropbox/authorize` and open the returned
`authorize_url` in a browser.

**Disconnecting** (`DELETE /storage/dropbox`, or the button) first copies every file
back to the server, so make sure it has the disk space. If a file cannot be copied
back, nothing is changed. The copies in Dropbox are left there.

## Limits worth knowing

- Fades are a fade-out followed by a fade-in, not an overlap of the two, and are
  available on MP3 streams only.
- Silence detection recognises digital silence only; it does not measure loudness.
- The ident is one per station and is used for every change, in both directions.
- When the primary and the backup are both down, the ident is heard twice, as each one
  is given up on, with the failover delay between them.
- A station that starts up with both streams down goes straight to the fallback file.
- If the master cannot be reached when a streaming server needs a file it has not
  fetched yet, the file is skipped and the station behaves as if it had none.
