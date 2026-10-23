FROM oven/bun:1.4.4-alpine AS base
WORKDIR /app

# Manifests first: this layer is cached until a dependency actually changes,
# so editing source does not reinstall node_modules.
#
# Every workspace has to be here, dev dependencies included. A pruned checkout
# must keep each workspace its survivors name, and bun checks that against
# bun.lock before it looks at whether --production would have skipped the edge
# -- so @omni/testkit needs a line even though nothing under src/ imports it.
# Omitting one is not a slow image, it is `bun install` refusing to run at all.
COPY package.json bun.lock ./
COPY packages/control/package.json packages/control/
COPY packages/coord/package.json packages/coord/
COPY packages/dashboard-sdk/package.json packages/dashboard-sdk/
COPY packages/ir/package.json packages/ir/
COPY packages/plugin-api/package.json packages/plugin-api/
COPY packages/ponytail/package.json packages/ponytail/
COPY packages/providers/package.json packages/providers/
COPY packages/ratelimit/package.json packages/ratelimit/
COPY packages/router/package.json packages/router/
COPY packages/rtk/package.json packages/rtk/
COPY packages/store/package.json packages/store/
COPY packages/testkit/package.json packages/testkit/
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/

# The console is built here, with dev dependencies, and only its output is
# carried forward. One install rather than two: the dashboard's build reaches
# the SDK and the store's types through the workspace, so a partial install
# fails its typecheck with a module it cannot find.
FROM base AS build
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/gateway apps/gateway
COPY apps/dashboard apps/dashboard
# The regular build's `typecheck` step reaches the repository's `scripts/` for two
# import-boundary tests, which do not ship; CI typechecks, the image compiles.
RUN bun run --cwd apps/dashboard build:production
COPY scripts/build-binary.ts scripts/build-binary.ts
RUN bun run build:binary

# Runtime: only the standalone gateway and built console, no separate Bun or npm tree.
FROM alpine:3.22 AS runner
WORKDIR /app
RUN apk add --no-cache ca-certificates libgcc libstdc++ \
 && addgroup -g 1000 bun \
 && adduser -D -u 1000 -G bun bun
COPY --from=build /app/dist/omnigateway /app/omnigateway
COPY --from=build /app/apps/dashboard/dist /app/public

# Plugins are read from `$OMNI_ROOT/plugins` at boot. On one node that is the
# data volume, so `omni plugin install` against it survives a restart; in a
# fleet, bake them in — `COPY plugins/ /data/plugins/` in a derived image — so
# every replica holds the same set. The directory exists either way, so the
# boot line names a path rather than an absence.
RUN mkdir -p /data/plugins && chown -R bun:bun /data
USER bun

# The tag is handed in by the release workflow, independently of compilation.
ARG OMNI_VERSION=0.0.0-dev
ENV OMNI_VERSION=$OMNI_VERSION
ENV OMNI_HOST=0.0.0.0 \
    OMNI_PORT=9000 \
    OMNI_ROOT=/data \
    OMNI_DB_PATH=/data/omnigateway.db \
    OMNI_STATIC_DIR=/app/public

# Single-node: credentials outlive the container. Without this, `docker rm`
# deletes them. Cluster mode (OMNI_DATABASE_URL set) writes nothing here and
# the volume may be omitted.
VOLUME /data
EXPOSE 9000

# `/health` is unauthenticated liveness and stays live through a restore; it
# answers `ok` before the store is asked anything, which is what a liveness
# probe should read.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:9000/health"]

# OMNI_ENCRYPTION_KEY is deliberately not set. The gateway refuses to boot
# without it, which is the intended behaviour: baking a key into an image
# would mean every deployment of it shares one.
CMD ["/app/omnigateway"]
