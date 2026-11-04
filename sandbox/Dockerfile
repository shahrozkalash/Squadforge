# Image for SquadForge execution containers, preview relays, and the egress proxy.
# Build it on the Docker worker: docker build -t squadforge-sandbox:1 sandbox
FROM node:22-slim

RUN groupadd --gid 10001 sandbox \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/sandbox --shell /usr/sbin/nologin sandbox \
  && mkdir -p /workspace /opt/squadforge \
  && chown sandbox:sandbox /workspace

COPY relay.mjs egress-proxy.mjs /opt/squadforge/

USER 10001:10001
WORKDIR /workspace
