FROM oven/bun:1.4-slim

WORKDIR /app

# Manifests first: this layer is cached until a dependency actually changes,
# so editing source does not reinstall node_modules.
COPY package.json bun.lock ./
COPY packages/ir/package.json packages/ir/
COPY packages/store/package.json packages/store/
COPY packages/providers/package.json packages/providers/
COPY apps/gateway/package.json apps/gateway/
RUN bun install --frozen-lockfile --production

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/gateway apps/gateway

ENV OMNI_HOST=0.0.0.0 \
    OMNI_PORT=9000 \
    OMNI_DB_PATH=/data/omnigateway.db

# Credentials outlive the container. Without this, `docker rm` deletes them.
VOLUME /data
EXPOSE 9000

# OMNI_ENCRYPTION_KEY is deliberately not set. The gateway refuses to boot
# without it, which is the intended behaviour: baking a key into an image
# would mean every deployment of it shares one.
CMD ["bun", "apps/gateway/src/index.ts"]
