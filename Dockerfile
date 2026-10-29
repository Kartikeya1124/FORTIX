FROM node:22-alpine AS base
WORKDIR /app
# Install dependencies needed for node-gyp and native modules if any
RUN apk add --no-cache python3 make g++

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=8080

# Create a non-root user and writable artifact/report directories
RUN addgroup -S fortix && adduser -S fortix -G fortix && \
    mkdir -p /app/storage/artifacts /app/reports && \
    chown -R fortix:fortix /app

COPY --from=builder --chown=fortix:fortix /app/package.json ./
COPY --from=builder --chown=fortix:fortix /app/node_modules ./node_modules
COPY --from=builder --chown=fortix:fortix /app/dist ./dist
COPY --from=builder --chown=fortix:fortix /app/drizzle ./drizzle

USER fortix

EXPOSE 8080

# Use node instead of cross-env or tsx in production
CMD ["node", "dist/server.cjs"]
