FROM node:24-alpine

LABEL org.opencontainers.image.title="DOKSCP MCP Server" \
      org.opencontainers.image.description="Model Context Protocol server for deploying local and GitHub projects to DOKSCP from IDE agents." \
      org.opencontainers.image.vendor="DOKSCP"

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && addgroup -S dokscp \
    && adduser -S dokscp -G dokscp

COPY src ./src
COPY scripts ./scripts
COPY README.md ./README.md

USER dokscp

CMD ["node", "src/index.js"]
