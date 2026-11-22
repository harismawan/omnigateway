ARG ARTIFACTS=compiled
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine AS base
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

# Native musl build on each buildx target (QEMU on single-architecture hosts).
# Keep the compiler pin aligned with rust-toolchain.toml.
FROM rust:1.100-alpine AS rust-build
WORKDIR /app
RUN apk add --no-cache build-base perl linux-headers
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
ARG OMNI_VERSION=0.0.0-dev
ENV OMNI_CLI_VERSION=$OMNI_VERSION
RUN cargo build --locked --release -p omni-gateway --bin omnigateway

FROM scratch AS binary
COPY --from=rust-build /app/target/release/omnigateway /omnigateway

FROM --platform=$BUILDPLATFORM alpine:3.22 AS rootfs
RUN apk add --no-cache ca-certificates \
 && mkdir -p /out/etc/ssl/certs /out/data/plugins /out/tmp /out/usr/local/bin \
 && cp /etc/ssl/certs/ca-certificates.crt /out/etc/ssl/certs/ \
 && ln -s certs/ca-certificates.crt /out/etc/ssl/cert.pem \
 && printf 'bun:x:1000:1000::/data:/sbin/nologin\n' > /out/etc/passwd \
 && printf 'bun:x:1000:\n' > /out/etc/group \
 && chown -R 1000:1000 /out/data \
 && chmod 1777 /out/tmp \
 && ln -s /app/omnigateway /out/usr/local/bin/omni

FROM scratch AS compiled
COPY --from=rust-build /app/target/release/omnigateway /omnigateway
COPY --from=build /app/apps/dashboard/dist /public

FROM scratch AS prebuilt
ARG TARGETARCH
COPY prebuilt/${TARGETARCH}/omnigateway /omnigateway
COPY prebuilt/${TARGETARCH}/public /public

FROM ${ARTIFACTS} AS artifacts

# Runtime: only the standalone gateway, built console and minimal rootfs, no shell or Bun.
FROM scratch AS runner
WORKDIR /app
COPY --from=rootfs /out/ /
COPY --from=artifacts /omnigateway /app/omnigateway
COPY --from=artifacts /public /app/public

# Keep `$OMNI_ROOT/plugins` on the data volume. A derived image can stage files
# with `COPY plugins/ /data/plugins/`, without a shell. This Rust release does
# not load plugins or support plugin installation.
USER bun

# The tag is handed in by the release workflow, independently of compilation.
ARG OMNI_VERSION=0.0.0-dev
ENV OMNI_VERSION=$OMNI_VERSION
ENV OMNI_HOST=0.0.0.0 \
    OMNI_PORT=9000 \
    OMNI_ROOT=/data \
    OMNI_DB_PATH=/data/omnigateway.db \
    OMNI_STATIC_DIR=/app/public \
    MIMALLOC_PURGE_DELAY=1

# Single-node: credentials outlive the container. Without this, `docker rm`
# deletes them. Cluster mode (OMNI_DATABASE_URL set) writes nothing here and
# the volume may be omitted.
VOLUME /data
EXPOSE 9000

# `/health` is unauthenticated liveness and stays live through a restore; it
# answers `ok` before the store is asked anything, which is what a liveness
# probe should read. Use only process env, like the gateway entrypoint.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/omni", "health", "--env-only"]

# OMNI_ENCRYPTION_KEY is deliberately not set. The gateway refuses to boot
# without it, which is the intended behaviour: baking a key into an image
# would mean every deployment of it shares one.
CMD ["/app/omnigateway"]
