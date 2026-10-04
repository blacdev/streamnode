# syntax=docker/dockerfile:1
FROM rust:1-slim-bookworm AS builder
# For the part of FFmpeg the engine links in (see build-ffmpeg.sh), and for
# generating its Rust bindings.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates xz-utils make nasm pkg-config clang libclang-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Its own layer: rebuilt only when the script changes.
COPY build-ffmpeg.sh ./
RUN ./build-ffmpeg.sh /opt/ffmpeg
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# Cache mounts keep the crate registry and compiled dependencies between builds.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    FFMPEG_DIR=/opt/ffmpeg cargo build --release --locked --features static-ffmpeg \
    && cp target/release/streamnode /streamnode && mkdir /data

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
COPY --from=builder /streamnode /app/streamnode
# Where a slave node keeps its enrolment; owned by the unprivileged user so a
# volume mounted here is writable.
COPY --from=builder --chown=nonroot:nonroot /data /data
USER nonroot:nonroot
EXPOSE 3000
ENV RUST_LOG=info
ENTRYPOINT ["/app/streamnode"]
