# ZSmart Branch backend API (Express, ES modules) — production image for a Linux host.
#
# Nothing secret is baked in: MongoDB URI, FlexCube credentials, JWT/encryption keys, CORS
# origins … come from the environment when the container runs
# (see deploy/app-server/env/backend.env.example).
#
# FlexCube is reached in Oracle "thick" mode, so the image carries Oracle Instant Client —
# the same 23.6 release the Windows machines use. Override INSTANT_CLIENT_URL to change it.

ARG NODE_IMAGE=node:22-bookworm-slim
# Full image (same Debian release) with python3/make/g++ preinstalled, for compiling native
# modules. Only used to install dependencies; the runtime image stays slim.
ARG BUILD_IMAGE=node:22-bookworm

# ── Oracle Instant Client ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS oracle
ARG INSTANT_CLIENT_URL=https://download.oracle.com/otn_software/linux/instantclient/2360000/instantclient-basic-linux.x64-23.6.0.24.10.zip
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && curl -fsSL --retry 3 -o /tmp/instantclient.zip "$INSTANT_CLIENT_URL" \
 && mkdir -p /opt/oracle \
 && unzip -q /tmp/instantclient.zip -d /opt/oracle \
 && mv /opt/oracle/instantclient_* /opt/oracle/instantclient \
 && rm -f /opt/oracle/instantclient/*.jar /tmp/instantclient.zip \
 && rm -rf /var/lib/apt/lists/*

# ── Production dependencies ──────────────────────────────────────────────────────
# bcrypt is native: it downloads a prebuilt binary, or compiles from source with the build
# image's compilers when GitHub is not reachable from the build machine.
FROM ${BUILD_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Runtime ──────────────────────────────────────────────────────────────────────
# The first three steps are identical in the frontend image, so both images share these
# layers (incl. the ~300 MB Instant Client) in the build cache and on the server's disk.
FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends libaio1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=oracle /opt/oracle/instantclient /opt/oracle/instantclient
RUN echo /opt/oracle/instantclient > /etc/ld.so.conf.d/oracle-instantclient.conf && ldconfig
# UV_THREADPOOL_SIZE: Oracle thick mode runs every database call on a libuv thread. Node's
# default is 4, so only 4 FlexCube calls could run at once whatever the pool size. Keep it
# above FLEXCUBE_POOL_MAX (default 20) with room for file, DNS and bcrypt work.
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=24 \
    PORT=5000 \
    TZ=Africa/Addis_Ababa \
    ORACLE_CLIENT_PATH=/opt/oracle/instantclient

WORKDIR /app
# Code and dependencies stay root-owned (read-only for the app). The only writable place is
# uploads/, which docker-compose mounts from the host so files survive container rebuilds.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p uploads && chown node:node uploads

USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "app.js"]
