FROM oven/bun:1.4-slim AS base
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
# The build's own `typecheck` step reaches the repository's `scripts/` for two
# import-boundary tests, which do not ship; CI typechecks, the image compiles.
RUN cd apps/dashboard && bun run generate:routes && bunx vite build && bun run build:shared

# Runtime: production dependencies only, the gateway's source, the built console.
FROM base AS runner
RUN bun install --frozen-lockfile --production
COPY tsconfig.base.json ./
COPY --from=build /app/packages packages
COPY --from=build /app/apps/gateway apps/gateway
# `dashboardDir()` looks here second, after `apps/gateway/src/public`; the
# path is the one a checkout would have, so no OMNI_STATIC_DIR is needed.
COPY --from=build /app/apps/dashboard/dist apps/dashboard/dist

# Plugins are read from `$OMNI_ROOT/plugins` at boot. On one node that is the
# data volume, so `omni plugin install` against it survives a restart; in a
# fleet, bake them in — `COPY plugins/ /data/plugins/` in a derived image — so
# every replica holds the same set. The directory exists either way, so the
# boot line names a path rather than an absence.
RUN mkdir -p /data/plugins && chown -R bun:bun /data
USER bun

# The tag, handed in by the release workflow: the image runs source, not the
# npm bundle, so nothing substituted a version and the console would print
# `0.0.0-dev` for every deployed release.
ARG OMNI_VERSION=0.0.0-dev
ENV OMNI_VERSION=$OMNI_VERSION
ENV OMNI_HOST=0.0.0.0 \
    OMNI_PORT=9000 \
    OMNI_ROOT=/data \
    OMNI_DB_PATH=/data/omnigateway.db

# Single-node: credentials outlive the container. Without this, `docker rm`
# deletes them. Cluster mode (OMNI_DATABASE_URL set) writes nothing here and
# the volume may be omitted.
VOLUME /data
EXPOSE 9000

# `/health` is unauthenticated liveness and stays live through a restore; it
# answers `ok` before the store is asked anything, which is what a liveness
# probe should read.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:9000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# OMNI_ENCRYPTION_KEY is deliberately not set. The gateway refuses to boot
# without it, which is the intended behaviour: baking a key into an image
# would mean every deployment of it shares one.
CMD ["bun", "apps/gateway/src/index.ts"]
