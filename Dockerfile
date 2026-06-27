# Stage 1: Builder
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install system deps including python3 (for native npm modules + openpyxl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install openpyxl here in builder (shell + pip available here)
RUN pip3 install openpyxl --break-system-packages

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Stage 2: Production image (distroless - no shell)
FROM gcr.io/distroless/nodejs20-debian12

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy app and node_modules from builder
COPY --from=builder /app /app

# Copy python3 runtime and openpyxl from builder into final image
COPY --from=builder /usr/bin/python3 /usr/bin/python3
COPY --from=builder /usr/bin/python3.11 /usr/bin/python3.11
COPY --from=builder /usr/lib/python3 /usr/lib/python3
COPY --from=builder /usr/lib/python3.11 /usr/lib/python3.11
COPY --from=builder /usr/local/lib/python3.11 /usr/local/lib/python3.11

EXPOSE 8080

CMD ["server.js"]