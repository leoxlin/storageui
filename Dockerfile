# syntax=docker/dockerfile:1

# ─── Dependencies ─────────────────────────────────────────────────────────────
# Installed for the target platform so native modules (sharp) match the image.
FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tests/dependency-security.test.mjs ./tests/
RUN bun run test:security

# ─── Build ────────────────────────────────────────────────────────────────────
# Runs on the build host's own platform: under QEMU (the arm64 half of a
# multi-arch build on amd64 runners) Bun crashes with SIGTRAP in `next build`.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so they
# must be provided here (not at runtime). Override with --build-arg as needed.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_BASE_PATH=
ARG NEXT_PUBLIC_ASSET_PREFIX=
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH \
    NEXT_PUBLIC_ASSET_PREFIX=$NEXT_PUBLIC_ASSET_PREFIX \
    NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN bun run build

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14 AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Ship only what `next start` needs to run: build output, static assets,
# config, and the installed dependencies.
COPY --from=builder --chown=bun:bun /app/.next ./.next
COPY --from=builder --chown=bun:bun /app/public ./public
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=builder --chown=bun:bun /app/next.config.mjs ./next.config.mjs

# Server-side connection and auth vars (STORAGE_*, AUTH_*) are read at runtime;
# pass them with `-e` / `--env-file` when starting the container.

USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
