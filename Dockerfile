# syntax=docker/dockerfile:1

# Build info (injected by release.yml; local builds fall back to these)
ARG BUILD_VERSION=dev
ARG BUILD_COMMIT=unknown

# Must build the image rather than mount the code onto the official node
# image: @cursor/sdk carries platform-specific native modules (sandbox
# helpers, ripgrep, etc.), which only install for the target platform when
# npm install runs there (the linux-x64 build).
#
# node:22-slim: the SDK requires >= 22.13.
FROM node:22-slim

WORKDIR /app

# Dependency layer cached separately: only reinstall when package.json changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-fund --no-audit

# OTA needs git (git mode) and tar (zip-mode fallback; bundles the release
# source package as tar.gz).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tar \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src

# Run as non-root. Both UID and GID are pinned explicitly — with only -u,
# the GID is assigned by the system, and host-side mount permissions set
# against a fixed uid would not line up.
RUN groupadd -r -g 10003 cursorapi \
 && useradd -r -u 10003 -g 10003 -m cursorapi \
 && mkdir -p /data /work \
 && chown -R cursorapi:cursorapi /app /data /work
USER cursorapi

ENV NODE_ENV=production \
    CURSOR_HOST=0.0.0.0 \
    CURSOR_PORT=8008 \
    CURSOR_ACCOUNTS=/data/accounts.json \
    CURSOR_WORKSPACE=/work \
    CURSOR_BUILD_VERSION=$BUILD_VERSION \
    CURSOR_BUILD_COMMIT=$BUILD_COMMIT

EXPOSE 8008

# /ping needs no auth — that is exactly what health checks are for.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CURSOR_PORT||8008)+'/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "boot.mjs"]
