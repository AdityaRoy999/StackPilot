FROM node:24-alpine

LABEL org.opencontainers.image.title="StackPilot MCP Server" \
      org.opencontainers.image.description="Model Context Protocol server for deploying local and GitHub projects to StackPilot from IDE agents." \
      org.opencontainers.image.vendor="StackPilot"

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && addgroup -S stackpilot \
    && adduser -S stackpilot -G stackpilot

COPY src ./src
COPY scripts ./scripts
COPY README.md ./README.md

USER stackpilot

CMD ["node", "src/index.js"]
