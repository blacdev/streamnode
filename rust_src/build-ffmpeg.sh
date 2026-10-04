#!/bin/sh
# Builds the small part of FFmpeg the engine uses and installs it as static
# libraries, so that the engine carries it inside its own binary and the
# server needs nothing installed.
#
# The engine decodes a little of each stream to hear whether it is silent.
# For that it needs two decoders, MP3 and AAC, and nothing else of FFmpeg: no
# programs, no encoders, no network code, no other formats.
#
#   ./build-ffmpeg.sh [PREFIX]      default PREFIX: /opt/ffmpeg
#
# Then build the engine with:
#   FFMPEG_DIR=PREFIX cargo build --release --features static-ffmpeg
#
# Needs: a C compiler, make, curl, xz. nasm is used when present (faster decoding).
set -eu

VERSION="${FFMPEG_VERSION:-9.0.1}"
SHA256="${FFMPEG_SHA256:-cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635}"
PREFIX="${1:-/opt/ffmpeg}"

if [ -f "$PREFIX/lib/libavcodec.a" ] && [ "$(cat "$PREFIX/version" 2>/dev/null)" = "$VERSION" ]; then
  echo "FFmpeg $VERSION is already built in $PREFIX."
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "Downloading FFmpeg $VERSION..."
curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$work/ffmpeg.tar.xz"
echo "$SHA256  $work/ffmpeg.tar.xz" | sha256sum -c - >/dev/null || { echo "The FFmpeg download does not match its expected checksum." >&2; exit 1; }
mkdir "$work/src"
tar -xJf "$work/ffmpeg.tar.xz" -C "$work/src" --strip-components=1
cd "$work/src"

asm=""
command -v nasm >/dev/null 2>&1 || asm="--disable-x86asm"
echo "Building (decoders: mp3, aac)..."
# shellcheck disable=SC2086
./configure --prefix="$PREFIX" \
  --disable-everything --disable-programs --disable-doc --disable-autodetect --disable-network \
  --disable-avdevice --disable-avfilter --disable-swscale --disable-swresample --disable-debug \
  --enable-static --disable-shared --enable-pic \
  --enable-decoder=mp3float --enable-decoder=aac $asm >/dev/null
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)" >/dev/null
make install >/dev/null
echo "$VERSION" > "$PREFIX/version"
echo "FFmpeg $VERSION installed in $PREFIX."
