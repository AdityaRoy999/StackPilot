FROM node:24-alpine AS base

WORKDIR /app
ENV STACKPILOT_BACKEND_INTERNAL_URL=http://backend:8090

ENV NEXT_TELEMETRY_DISABLED=1

COPY package*.json .npmrc* ./
RUN npm ci --no-audit --no-fund

# ─── Development Target (Live Hot-Reloading) ───────────────
FROM base AS dev

WORKDIR /app

ENV NODE_ENV=development \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Compile on Docker's Linux filesystem. Compose Watch syncs host edits here.
COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["npm", "run", "dev"]

# ─── Production Builder ─────────────────────────────────────
FROM base AS builder

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8090/api/v1
ARG NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8090
ARG NEXT_PUBLIC_AI_SERVICE_WS_URL=
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ARG NEXT_PUBLIC_GITHUB_CLIENT_ID=

ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_WS_BASE_URL=${NEXT_PUBLIC_WS_BASE_URL}
ENV NEXT_PUBLIC_AI_SERVICE_WS_URL=${NEXT_PUBLIC_AI_SERVICE_WS_URL}
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}
ENV NEXT_PUBLIC_GITHUB_CLIENT_ID=${NEXT_PUBLIC_GITHUB_CLIENT_ID}

COPY . .
RUN npm run build

# ─── Production Runner ──────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
    CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
