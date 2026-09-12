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
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The worker keeps a WebSocket to LiveKit; no inbound port is required.
CMD ["node", "dist/agent.js", "start"]
