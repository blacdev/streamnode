# syntax=docker/dockerfile:1
FROM rust:1-slim-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# Cache mounts keep the crate registry and compiled dependencies between builds.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked && cp target/release/radio_gateway /radio_gateway && mkdir /data

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
COPY --from=builder /radio_gateway /app/radio_gateway
# Where a slave node keeps its enrolment; owned by the unprivileged user so a
# volume mounted here is writable.
COPY --from=builder --chown=nonroot:nonroot /data /data
USER nonroot:nonroot
EXPOSE 3000
ENV RUST_LOG=info
ENTRYPOINT ["/app/radio_gateway"]
