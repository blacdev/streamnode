# Generates two short test tones and serves them as endless radio streams.
FROM alpine:3.20 AS audio
RUN apk add --no-cache ffmpeg
WORKDIR /audio
# Headerless constant-bitrate MP3 so the files loop seamlessly.
RUN ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=12" -af "tremolo=f=2:d=0.8,volume=0.5" \
      -ac 1 -ar 44100 -c:a libmp3lame -b:a 96k -write_xing 0 -id3v2_version 0 primary.mp3 && \
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=660:duration=12" -af "tremolo=f=6:d=0.8,volume=0.5" \
      -ac 1 -ar 44100 -c:a libmp3lame -b:a 96k -write_xing 0 -id3v2_version 0 backup.mp3 && \
    ffmpeg -loglevel error -f lavfi -i "anullsrc=r=44100:cl=mono" -t 12 \
      -ac 1 -ar 44100 -c:a libmp3lame -b:a 96k -write_xing 0 -id3v2_version 0 silence.mp3
# Files to upload while trying idents and fallback audio. The first two match
# the demo stream (MP3, 96 kbps, 44.1 kHz, mono); the others are refused, each
# for a different reason.
WORKDIR /samples
RUN M="-ac 1 -ar 44100 -c:a libmp3lame -b:a 96k" && \
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=880:duration=3" -af "tremolo=f=10:d=0.9,volume=0.5" $M ident.mp3 && \
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=330:duration=30" -af "tremolo=f=1:d=0.9,volume=0.5" $M fallback.mp3 && \
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=880:duration=9" -af "volume=0.5" $M refused-ident-too-long.mp3 && \
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=330:duration=10" -af "volume=0.5" -ac 2 -ar 44100 -c:a libmp3lame -b:a 128k refused-128k-stereo.mp3 && \
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=330:duration=10" -af "volume=0.5" -ac 1 -ar 44100 -c:a libmp3lame -q:a 5 refused-variable-bitrate.mp3 && \
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=330:duration=3" -af "volume=0.5" -ac 1 -ar 44100 refused-not-mp3.wav

FROM node:22-alpine
WORKDIR /app
COPY source.js .
COPY --from=audio /audio ./audio
COPY --from=audio /samples ./samples
USER node
EXPOSE 8000
CMD ["node", "source.js"]
