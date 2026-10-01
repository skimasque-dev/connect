FROM node:24-bookworm-slim AS node
FROM rust:1.88-bookworm AS rust
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl iproute2 iputils-ping openssl \
    pkg-config python3 sudo systemd-resolved dbus unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
WORKDIR /workspace
