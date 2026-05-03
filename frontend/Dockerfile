# Base image
FROM node:22-alpine AS builder

WORKDIR /app

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8090/api/v1
ARG NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8090
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ARG NEXT_PUBLIC_GITHUB_CLIENT_ID=

ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_WS_BASE_URL=${NEXT_PUBLIC_WS_BASE_URL}
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}
ENV NEXT_PUBLIC_GITHUB_CLIENT_ID=${NEXT_PUBLIC_GITHUB_CLIENT_ID}

# Install dependencies
COPY package*.json ./
RUN npm ci --no-audit --no-fund

# Build the frontend
COPY . .
RUN npm run build

# Production image
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["npm", "start"]
