# syntax=docker/dockerfile:1
# Open Rummy - container image for AWS Lightsail container service (or any Docker host).
# Build:  docker build -t open-rummy:latest .
# Run:    docker run --rm -p 8080:8080 open-rummy:latest   then open http://localhost:8080

# ---- Build stage: install workspace deps, run the client (vite) and server (esbuild) builds ----
FROM node:22-alpine AS build
WORKDIR /src

# Copy manifests first so `npm ci` is cached until dependencies change.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --no-audit --no-fund

COPY packages ./packages
# Vite + three.js can be memory hungry; give the build a little headroom.
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build

# ---- Runtime stage: only the self-contained server bundle and the static client ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WEB_ROOT=/app/web \
    MAX_ROOMS=500 \
    TRUST_PROXY=1
# TRUST_PROXY=1: the Lightsail container service reaches the container only through its load
# balancer, which appends the client address to X-Forwarded-For; without it every player would
# share the balancer's IP for the per-IP limits (MAX_CONNS_PER_IP, MAX_ROOMS_PER_IP). When the
# port is published straight to the internet (docker run -p), pass -e TRUST_PROXY=0 so clients
# cannot spoof their address.
WORKDIR /app

# The server is bundled by esbuild into dist/server.js (dependencies included), so no
# node_modules are needed at runtime. Files stay root-owned and read-only for the app user.
COPY --from=build /src/packages/server/dist/ ./server/
COPY --from=build /src/packages/client/dist/ ./web/

USER node
EXPOSE 8080

# busybox wget ships with alpine; /healthz is served by the Node server.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "--max-old-space-size=256", "server/server.js"]
