# Next.js web image. Build context is the monorepo root.
# BuildKit may be disabled on Windows paths with non-ASCII chars.

ARG WEB_BASE_IMAGE=node:20-alpine

FROM ${WEB_BASE_IMAGE} AS deps
WORKDIR /app

# Use npmmirror — default registry is often slow/blocked during docker build in CN.
ENV npm_config_registry=https://registry.npmmirror.com

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci --no-audit --no-fund

FROM ${WEB_BASE_IMAGE} AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    npm_config_registry=https://registry.npmmirror.com

ARG FASTAPI_BASE_URL=http://api:8000
ENV FASTAPI_BASE_URL=${FASTAPI_BASE_URL}
ARG NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL=/downloads/zhixin-ai-windows.exe
ENV NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL=${NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/core ./packages/core

# Next standalone expects a public directory even when empty.
RUN mkdir -p apps/web/public \
    && npm --prefix apps/web run build

FROM ${WEB_BASE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Monorepo standalone layout keeps apps/web under the tracing root.
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
