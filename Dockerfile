# ── builder ────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install build deps for native modules (bcryptjs is JS so this is light)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# ── runner (distroless for minimal attack surface) ─────────────────────────
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy app + production node_modules
COPY --from=builder /app /app

# Distroless runs as non-root by default (uid 65532) — good
EXPOSE 8080

# Cloud Run sends SIGTERM on shutdown; server.js handles it
CMD ["server.js"]
