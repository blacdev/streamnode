# Listener and player guide

Which address to give to which player, and how to put a player on a web page.
Replace `stream.example.com` with your gateway's domain and `powerbeats` with the
station's slug.

## Addresses

| Address | Use for |
|---|---|
| `https://stream.example.com/powerbeats` | Web players, phones, modern apps |
| `http://stream.example.com/powerbeats` | Hardware Wi-Fi radios, older players, anything that fails on HTTPS |
| `.../powerbeats.mp3` or `.../powerbeats.aac` | Players or directories that insist on a file extension. Same stream |
| `.../powerbeats.m3u` | Playlist file: "Listen" links on websites, VLC, Winamp, iTunes |
| `.../powerbeats.pls` | Playlist file for players that prefer PLS |

The extension is only a label. It does not convert the audio: an AAC station is still
AAC at `/powerbeats.mp3`. Use the extension that matches the station's real format.

## Compatibility

| Player or platform | Address to use | Song titles |
|---|---|---|
| VLC, Winamp, foobar2000, Audacious | Stream or `.m3u` | Yes |
| iTunes / Apple Music (Open Stream) | Stream or `.m3u` | Yes |
| Windows Media Player | `.m3u` | Varies |
| Hardware Wi-Fi radios, receivers | `http://` stream | On most models |
| Sonos, Bose and similar | `http://` or `https://` stream, added as a custom station | Varies |
| TuneIn, Radio Garden, radio-browser and other directories | `https://` stream (`http://` if rejected) | Read by the directory |
| Chrome, Firefox, Safari, Edge (HTML `<audio>`) | `https://` stream | Use the now-playing endpoint |
| Android and iOS apps | `https://` stream | Depends on the app |
| Amazon Alexa and Google Assistant radio skills | `https://` stream | Depends on the skill |

Behaviour was verified directly against the gateway for the stream protocol itself
(plain and metadata-enabled requests, `HEAD` and `OPTIONS` probes, playlists, CORS).
Individual devices differ; if one cannot connect over HTTPS, the `http://` address is
the fix in almost every case.

### What the gateway sends

| Feature | Detail |
|---|---|
| Stream headers | The source's `Content-Type`, `icy-name`, `icy-genre`, `icy-br`, `icy-sr`, `icy-url`, `icy-description`, `icy-pub` and `ice-audio-info`, unchanged |
| In-stream titles | Sent only to players that request them with `Icy-MetaData: 1` (interval 16,000 bytes), including the artwork address as `StreamUrl` |
| Browser access | `Access-Control-Allow-Origin: *` on streams and playlists |
| Caching | Disabled with `Cache-Control: no-cache, no-store` |
| Fast start | A few seconds of recent audio are sent immediately on connect |
| Probes | `HEAD` and `OPTIONS` are answered without counting as a listener |

## Web player

A complete player with title and artwork. Paste it into any page and change the two
values at the top of the script.

```html
<div id="radio" style="display:flex;align-items:center;gap:12px;font-family:sans-serif">
  <img id="radio-art" alt="" width="64" height="64" style="border-radius:8px;object-fit:cover;background:#ddd">
  <div>
    <strong id="radio-name">Radio</strong>
    <div id="radio-title" style="color:#666">&nbsp;</div>
    <audio id="radio-audio" controls preload="none"></audio>
  </div>
</div>
<script>
  const GATEWAY = 'https://stream.example.com';
  const STATION = 'powerbeats';

  const audio = document.getElementById('radio-audio');
  audio.src = `${GATEWAY}/${STATION}`;

  async function refresh() {
    try {
      const res = await fetch(`${GATEWAY}/api/v1/public/stations/${STATION}/now-playing`);
      if (!res.ok) return;
      const now = await res.json();
      document.getElementById('radio-name').textContent = now.name;
      document.getElementById('radio-title').textContent =
        [now.artist, now.title].filter(Boolean).join(' - ') || ' ';
      if (now.artwork) document.getElementById('radio-art').src = now.artwork;
    } catch (e) { /* keep the last title on a network error */ }
  }
  refresh();
  setInterval(refresh, 10000);
</script>
```

Notes for web pages:

- A page served over `https://` must use the `https://` stream address.
- Browsers do not start audio until the visitor presses play.
- Titles appear once playback starts, because the gateway tracks titles only while a
  station has listeners.
- After a pause, a browser resumes from its buffer and drifts behind live. To jump
  back to live on play, reload the source:

  ```js
  audio.addEventListener('pause', () => { audio.removeAttribute('src'); audio.load(); });
  audio.addEventListener('play', () => { if (!audio.src) { audio.src = `${GATEWAY}/${STATION}`; audio.play(); } });
  ```

## A simple "Listen" link

```html
<a href="https://stream.example.com/powerbeats.m3u">Listen live</a>
```

This opens the visitor's own player (VLC, iTunes, Winamp).

## Submitting to directories

Most directories ask for a stream address, a name, a genre and artwork.

1. Give the `https://` stream address. If the form rejects it, try the `http://`
   address, then the `.mp3` or `.aac` form.
2. The directory will test the stream. Its test connection needs your source to be
   online, since the gateway connects to it on demand.
3. Directory crawlers that play the stream count as listeners while they are
   connected.
