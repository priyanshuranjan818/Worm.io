# ─────────────────────────────────────────────────────────────────
# HaxxWorm.io — Dockerfile
# Production-ready multi-stage image
# ─────────────────────────────────────────────────────────────────

# ── Stage 1: Install dependencies ────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package files first (layer caching — only reinstalls when deps change)
COPY package*.json ./
RUN npm ci --only=production

# ── Stage 2: Production image ────────────────────────────────────
FROM node:20-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S haxxworm && \
    adduser  -u 1001 -S haxxworm -G haxxworm

WORKDIR /app

# Copy deps from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY server/   ./server/
COPY public/   ./public/
COPY maps/     ./maps/
COPY package.json ./

# Set ownership
RUN chown -R haxxworm:haxxworm /app

USER haxxworm

# Expose game server port
EXPOSE 3000

# Health check for ECS/Kubernetes/ALB
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Graceful shutdown: SIGTERM is sent by ECS/k8s, handled in index.js
STOPSIGNAL SIGTERM

CMD ["node", "server/index.js"]
