FROM node:20-alpine

# Run as non-root for least-privilege operation
RUN addgroup -S webhook && adduser -S webhook -G webhook

WORKDIR /app

# Install deps before copying source so layer is cached on dep changes
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY index.js ./
COPY public/ ./public/

# Drop to non-root user
USER webhook

EXPOSE 3088

# ── Environment variable reference ──────────────────────────────────────────
# BASE_URL             Base URL path for the app                    (default: "")
# RATE_LIMIT_MAX       Max requests per IP per RATE_LIMIT_WINDOW   (default: 100)
# RATE_LIMIT_WINDOW    Rate-limit window string                     (default: 1 minute)
# MAX_VIEWERS_PER_PATH Max concurrent SSE viewers per path         (default: 50)
# BODY_LIMIT_BYTES     Max incoming request body size in bytes      (default: 65536)

ENV BASE_URL="" \
    RATE_LIMIT_MAX=100 \
    RATE_LIMIT_WINDOW="1 minute" \
    MAX_VIEWERS_PER_PATH=50 \
    BODY_LIMIT_BYTES=65536

# Docker-native health check — hits the /health endpoint every 30 s
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3088/health || exit 1

CMD ["node", "index.js"]