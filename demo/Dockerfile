# Generates two short test tones and serves them as endless radio streams.
FROM alpine:3.20 AS audio
RUN apk add --no-cache ffmpeg
WORKDIR /audio
# Headerless constant-bitrate MP3 so the files loop seamlessly.
RUN ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=12" -af "tremolo=f=2:d=0.8,volume=0.5" \
      -ac 1 -ar 44100 -c:a libmp3lame -b:a 96k -write_xing 0 -id3v2_version 0 primary.mp3 && \
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=660:duration=12" -af "tremolo=f=6:d=0.8,volume=0.5" \
      -ac 1 -ar 44100 -c:a libmp3lame -b:a 96k -write_xing 0 -id3v2_version 0 backup.mp3

FROM node:22-alpine
WORKDIR /app
COPY source.js .
COPY --from=audio /audio ./audio
USER node
EXPOSE 8000
CMD ["node", "source.js"]
