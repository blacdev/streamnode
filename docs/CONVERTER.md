# StreamNode Converter

A small desktop program, for **Windows and Linux**, that converts audio and video
files into the format of a radio stream, or into any format you set. It runs on your
own computer; nothing is uploaded anywhere.

Use it to prepare idents and fallback audio so that they match a station exactly, or
as a general converter.

## Getting it

| From | How |
|---|---|
| The dashboard | Station form → **When audio stops** → *Download for Windows* / *Download for Linux*. The Files tab has the same links |
| Any browser | `https://<your gateway>/api/v1/public/converter/windows` or `/linux` |
| The registry | `oras pull ghcr.io/blacdev/streamnode/converter:latest` fetches both downloads |
| A release | The two files are attached to each GitHub release |

Unpack the download and start `streamnode-converter` (`.exe` on Windows). Keep the
files in the folder together: `ffmpeg`, which does the converting, sits beside the
program. Each download is about 50 MB, nearly all of it ffmpeg.

## Using it

1. **Add a stream.** Paste the address listeners tune in to. The program listens for
   about ten seconds and learns the stream's format (MP3 or AAC, bitrate, sample rate,
   mono or stereo) and how loud it is. Add as many streams as you like; each keeps its
   own files and settings.
2. **Add files**, or drop them on the window. Audio and video both work: the sound is
   taken out of a video.
3. Each file is saved **beside its original**, in the stream's format and at the
   stream's loudness. Your original files are never changed or replaced; if the name is
   taken, the stream's name is added to it.

**No stream?** Choose *Your own settings* and pick the format yourself.

### Advanced

Every stream, and *Your own settings*, has an **Advanced** panel:

| Setting | Choices |
|---|---|
| Format | MP3, AAC (`.aac`, for streams), AAC in M4A, Ogg Vorbis, Opus, FLAC, WAV |
| Bitrate | 32 to 320 kbps (not used for FLAC and WAV) |
| Sample rate | 22.05 to 96 kHz, kept within what the format allows |
| Channels | Stereo or mono |
| Loudness | Leave as it is, match the stream, or bring to a level you set |
| Save in | Beside each original, or a folder you choose |

Changing a setting on a stream marks it *Changed from the stream's format*; one click
puts it back. Changes apply to files added afterwards.

### What it reads

MP3, AAC, M4A, WAV, FLAC, Ogg, Opus, WMA, AIFF and most others; and video such as MP4,
MKV, WebM, MOV, AVI and MPEG, from which the sound is taken.

## Good to know

- **HE-AAC (AAC+) streams** are recognised but cannot be matched: no free converter is
  allowed to make that format. Files become ordinary AAC instead, which plays anywhere
  but should not be cut into an HE-AAC stream. The gateway has the same limit.
- **It stays out of the way.** One file is converted at a time, on one processor core,
  at the lowest priority. While nothing is converting, the program does nothing at all:
  it redraws its window only when you use it. Measured on Linux: no processor time
  and about 64 MB of memory sitting open; while converting, the program itself uses
  under 1% of a core and ffmpeg at most one core and about 50 MB.
- **Start it for a station.** `streamnode-converter https://stream.example.com/station`
  opens it with that stream added; files named on the command line are queued.
- Closing the window stops a conversion that is under way; the unfinished file is
  not kept.
- Streams and settings are remembered between runs (`%APPDATA%\StreamNode Converter`
  on Windows, `~/.config/streamnode-converter` on Linux). The list of converted files
  is not.

## For administrators

The downloads are built by `.github/workflows/converter.yml` and published to the
container registry beside the gateway's images, at `ghcr.io/<owner>/<repo>/converter`,
as a package of two files (it is not an image to run). The package must be made
**public** once, like the engine and admin images.

The dashboard's download links go through the gateway, which fetches the file from the
registry and passes it on under its proper name; at most three downloads run at once.

| Setting | Default | Meaning |
|---|---|---|
| `CONVERTER_IMAGE` | `ghcr.io/<UPDATE_REPO>/converter` | Where the downloads are published |
| `CONVERTER_TAG` | `latest` | Which version is handed out |

## Building it yourself

```bash
cd converter_src
cargo test            # includes real conversions when ffmpeg is installed
cargo build --release
./target/release/streamnode-converter
```

It needs Rust and, to run, `ffmpeg` beside the program or on the `PATH`
(`STREAMNODE_FFMPEG` names another). The source is four files: `media.rs` (everything
that runs ffmpeg), `store.rs` (what is remembered, and the queue), `app.rs` (the
window) and `theme.rs` (how it looks).
