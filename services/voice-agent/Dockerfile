# UNIK voice agent worker (LiveKit Agents + OpenAI Realtime).
# Railway: set the service Root Directory to services/voice-agent.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
# The native WebRTC engine (@livekit/rtc-node, Rust) validates TLS against the
# system CA store, which the slim image does not ship. Without it joining a
# room fails with "no native root CA certificates found".
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The worker keeps a WebSocket to LiveKit; no inbound port is required.
CMD ["node", "dist/agent.js", "start"]
