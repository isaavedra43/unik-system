# ---------- deps: full install (devDeps needed for prisma generate + next build) ----------
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
# `prisma` postinstall and code generation need the schema early.
COPY prisma ./prisma

# Playwright's postinstall would otherwise download ~400MB of browsers that
# production never uses (they only exist for local test runs).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund

# ---------- build ----------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Standalone bundle: server.js + only the node_modules the app actually
# imports (nft tracing). No devDeps, no sources it never reads.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# The Daytona venue reads browser-controller.mjs / provision.sh from disk at
# runtime (src/modules/venues/daytona-venue.ts → process.cwd()/src/...).
COPY --from=builder /app/src/modules/venues/assets ./src/modules/venues/assets

# Railway pre-deploy runs `node scripts/prisma-deploy.mjs` → `npx prisma
# migrate deploy`: it needs the migrations, the script and the Prisma CLI +
# generated client, none of which are part of the standalone trace.
COPY prisma ./prisma
COPY scripts/prisma-deploy.mjs ./scripts/prisma-deploy.mjs
COPY --from=deps /app/node_modules/prisma ./node_modules/prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=deps /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Disk storage driver writes under cwd when used (storage/drivers/index.ts).
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
