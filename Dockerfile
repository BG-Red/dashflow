# syntax=docker/dockerfile:1

# ─── build ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.4-alpine AS build
WORKDIR /app

# Install with the lockfile first so dependency layers cache.
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/connectors/package.json packages/connectors/
COPY packages/demo/package.json packages/demo/
RUN bun install --frozen-lockfile

COPY . .
RUN bun run --filter '@dashflow/web' build

# Drop dev dependencies from the layer we copy forward.
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# ─── runtime ────────────────────────────────────────────────────────────────────
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    APP_ROLE=all \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist

RUN apk add --no-cache curl

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages

# bun's image ships a non-root `bun` user.
USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["bun", "apps/server/src/index.ts"]
