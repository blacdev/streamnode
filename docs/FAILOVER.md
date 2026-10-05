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
backup stream                   (if the station has one and it answers;
        │                        if it does not, straight on to the fallback file)
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

The delay is only for leaving a stream. Coming back needs no such wait, only proof
that the stream is really back: a stream that is down is tried again every 2 seconds,
and once it has delivered **five seconds** of real audio the station returns to it. A
stream that bursts into life for a moment and drops again does not pull listeners
back. How the change sounds depends on the station:

| The station has | What listeners hear |
|---|---|
| An ident | The ident, then the live stream |
| No ident, MP3 stream | What is playing fades out over a second and a half, and the live stream fades in over the same |
| No ident, AAC stream | A direct cut to the live stream |
| Nothing audible playing (silence) | The live stream starts at once, with no fade |

Fades are done without converting anything: each MP3 frame states its own volume, and
the gateway lowers that number step by step. AAC keeps its volume where only decoding
could reach it, so AAC stations get a direct cut; give them an ident for a smoother
change.

Every join is also made safe for players. An MP3 frame can depend on the frames before
it, so the first one or two frames of a stream that is being joined (about a twentieth
of a second) are sent as silence instead of being left to decode as a burst of noise. While the fallback file plays,
listeners see the station's own title, artist and image if it has them (see the
[Station guide](STATION_GUIDE.md#your-stations-own-title-artist-and-image)), and
otherwise the file's name as the title. The titles of the stream that stopped are not
shown, since that is not what is playing. The dashboard shows the station as
**On air (fallback audio)**.

If a station has none of these left (no backup, no fallback file), it behaves as
before: listeners are released after a few failed attempts and the dashboard shows
**Source offline**.

### "No audio" means

- the stream cannot be reached, ends, or stops sending data; or
- the stream keeps sending but carries **silence** (for example the studio feed into
  the encoder was unplugged); or
- the stream keeps sending but carries **nothing but hiss or other steady noise**,
  however loud.

Both are found by listening. Twice a second the gateway decodes a few frames of the
stream (about a tenth of a second of audio). What is decoded is only measured and then
discarded: listeners always receive the stream's own bytes, untouched.

**Silence** is a matter of level: anything quieter than **-55 dB** below full level
counts as silence. That covers true digital silence and the faint hiss of an open
input.

**Noise** is not a matter of level, because loud hiss is as loud as quiet music. Two
things give it away together: it has no pitch (its energy is spread evenly over all
frequencies, where music and voices have distinct tones), and it never changes (its
spectrum keeps the same shape from one moment to the next). Programme can be either
for an instant, a cymbal crash or a held note, but not both for seconds on end. A
stream that is both for four seconds running is treated as having no audio. Hiss that
dips or fades and comes back, as a looping noise track does, is still recognised.

Per station, in its edit form or with the API:

| Setting | Field | Default |
|---|---|---|
| Treat silence as no audio | `silence_detection` | on |
| Treat hiss and steady noise as no audio | `noise_detection` | on |
| Silence level | `silence_threshold_db` | the server's `SILENCE_THRESHOLD_DB`, -55 |

Switch noise detection off for a station that broadcasts noise-like sound on purpose
for seconds at a time: rain or sea ambience, long applause, static as an effect. Raise
the silence level (towards 0) only as a last resort for a station whose "silence" is
louder than -55 dB: quiet programme below the new level is then silence too.

Listening this way costs about 0.3% of one processor core per station on air (0.1%
with noise detection off). Changing any of these settings reconnects the station's
streams, so that they are judged on the new terms.

### The failover delay

One number per station, 1 to 300 seconds, **6 by default**: how long a stream may be
without audio before the station moves on. It is there to be sure the stream is really
down. A stream that comes back within the delay is simply carried on with, and nothing
else happens. The delay does not apply to coming back, which is immediate.

A short delay reacts faster but moves on during brief network hiccups. A long delay
rides those out but leaves listeners in silence for longer.

## Files: match the stream, or have them converted

Idents and fallback files are spliced into the same connection as the live stream. A
player that is given a different format in mid-stream stutters, plays at the wrong
speed or stops, so what is played must be exactly what the stream is:

| Must match | Example |
|---|---|
| Format | MP3 stream: MP3 file. AAC stream: AAC in an `.aac` (ADTS) file, not `.m4a` |
| Bitrate | 96 kbps stream: 96 kbps file. MP3 files must be **constant bitrate (CBR)** |
| Sample rate | 44.1 kHz stream: 44.1 kHz file |
| Channels | Stereo stream: stereo file |

The station's own format is shown next to the file choices in the dashboard once the
station has been on air, and in the API as `live.stream_format`.

**The best file is one already in that format.** It is played exactly as you made it,
byte for byte. Exporting with the free tool ffmpeg, for a 96 kbps stereo 44.1 kHz
stream:

```bash
ffmpeg -i input.wav -c:a libmp3lame -b:a 96k -ar 44100 -ac 2 output.mp3          # MP3
ffmpeg -i input.wav -c:a aac -b:a 96k -ar 44100 -ac 2 -f adts output.aac         # AAC
```

### Letting the gateway convert a file

A file in another format (WAV, FLAC, M4A, Ogg, or MP3/AAC with other settings) can be
converted for the station instead. This happens only **with your agreement**, because
of what it does:

- the file is **re-encoded** to the stream's format. If what you uploaded was already
  compressed (MP3, AAC, Ogg), that costs a little quality; from WAV or FLAC it does not;
- its **loudness is matched to the stream**: the gateway measures how loud the stream
  is on average while it plays, and turns the file up or down to that level (by at
  most 20 dB, with peaks held just below full scale), so an ident or fallback file is
  neither louder nor quieter than the programme around it;
- **the converted file takes the place of what you uploaded.** The upload itself is
  not kept.

You agree by ticking *Convert...* next to the upload in the dashboard, or by passing
`convert=true` in the API. Without it, such a file is refused with this explanation.

Choosing a file that is already in your storage for a station it does not match works
the same way: the dashboard asks, and on your yes a converted copy is made for that
station and replaces the original there. The original is removed if no other station
uses it.

Converting runs in the background, one file at a time. The file appears at once,
marked *Converting*, can be chosen straight away, and plays as soon as it is ready.
Converting is given one processor core at the lowest priority, so that it never
competes with listeners, and runs at roughly 20 times real time for MP3 and 14 times
for AAC: a few seconds for an ident, about 10 minutes for a three-hour mix. Live
streams are never converted.

What conversion needs:

- a **station**: the target format is that station's, so a file in another format has
  to be uploaded for a station (from its edit form, or with `station=` in the API);
- the station to **have been on air**, so that its format is known. Its loudness is
  known after about 20 seconds on air; before that the file is converted without a
  change of level;
- an **MP3 or plain AAC** stream. The gateway cannot produce HE-AAC, so for an HE-AAC
  station the file must be supplied in that format.

A file is still **refused, with the reason and what to do**, when:

| Refusal | What to do |
|---|---|
| Another format, and conversion not agreed to | Agree to the conversion, or export the file with the settings named in the message |
| Not audio | Upload MP3, AAC, WAV, FLAC, Ogg or M4A |
| Another format, with no station given or a station that has never been on air | Upload it from the station's form once the station has played |
| HE-AAC station and a file that does not match | Supply the file as HE-AAC with the stream's settings |
| Ident too long | Shorten it. The limit is 5 seconds unless the administrator changed it |
| Not enough storage | Delete files you no longer need, or ask the administrator for a larger quota. An upload must fit in the free space as uploaded, even though the converted file is usually smaller |

Other points:

- Only **MP3 and AAC** stations (including HE-AAC) can use idents and fallback files,
  and have silence detection. See
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
- Silence and noise detection sample the stream twice a second rather than listening
  to all of it. Silence is judged by peak level: sound quieter than the threshold is
  silence to it. Noise is judged by pitch and steadiness: deep rumble or hum with a
  clear tone to it is not recognised as noise, and a station whose programme really is
  steady pitchless sound needs noise detection switched off.
- The ident is one per station and is used for every change, in both directions.
- The ident is heard once per change. When the primary fails and the backup cannot be
  reached either, the station goes from one ident straight to the fallback file; if the
  backup returns later it is brought in then.
- Loudness is matched on average level, measured from a sample of the stream. It is a
  good match for programme material, not a broadcast loudness standard, and it is
  applied only to files the gateway converts: a file uploaded in the stream's own
  format is never altered.
- A station that starts up with both streams down goes straight to the fallback file.
- If the master cannot be reached when a streaming server needs a file it has not
  fetched yet, the file is skipped and the station behaves as if it had none.
