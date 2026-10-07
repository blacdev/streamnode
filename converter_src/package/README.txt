StreamNode Converter
====================

Converts audio and video files into the format of a radio stream, or into
any format you set.

How to start
------------
  Windows:  double-click streamnode-converter.exe
  Linux:    run ./streamnode-converter

Keep the files in this folder together. "ffmpeg" does the converting and the
program looks for it beside itself.

How to use
----------
1. Click "Add a stream" and paste the address listeners tune in to. The
   program listens for about ten seconds and learns the stream's format and
   loudness.
2. Click "Add files", or drop files on the window. Audio and video both
   work: the sound is taken out of a video.
3. Each file is saved beside its original, in the stream's format. Your
   original files are never changed.

No stream? Choose "Your own settings" and pick the format yourself.
"Advanced" lets you change the format, bitrate, sample rate, mono or stereo,
loudness, and where files are saved.

Good to know
------------
- HE-AAC (AAC+) streams are recognised but cannot be matched: no free
  converter is allowed to make that format. Files become ordinary AAC.
- One file is converted at a time, at low priority, so the computer stays
  usable. While nothing is converting the program uses no processor time.
- Start it with a stream address to open it ready for that station:
    streamnode-converter https://stream.example.com/yourstation

Licences
--------
The converter itself is part of StreamNode. It ships with:
- FFmpeg (https://ffmpeg.org), under the LGPL v2.1 or later. This is an
  unmodified build from https://github.com/BtbN/FFmpeg-Builds ; its source is
  available from both addresses. You may replace ffmpeg with your own build.
- The Inter and JetBrains Mono typefaces, under the SIL Open Font License.
- Phosphor icons, under the MIT License.
The licence texts are in the "licenses" folder.
