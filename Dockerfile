# Multi-stage Dockerfile for mca-filing-service.
#
# Base image: Playwright's official image bundles Chromium + system deps already.
# Per-job-login mode means the container is stateless w.r.t. MCA cookies — each SPOC
# logs in fresh, so we don't need to mount or pre-seed storage-state.json.
#
# Build:  docker build -t mca-filing-service .
# Run:    docker run --rm -p 8090:8090 \
#           -e MAX_CONCURRENT_JOBS=5 \
#           -e ADMIN_TOKEN=changeme \
#           -e HEADLESS=true \
#           -v $(pwd)/.artifacts:/app/.artifacts \
#           mca-filing-service

FROM mcr.microsoft.com/playwright:v1.50.0-jammy AS base

WORKDIR /app

# Copy package manifests first for better layer caching
COPY package.json package-lock.json* ./

# Install production deps. Skip Playwright browser download — the base image already has it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

# Copy source
COPY src ./src
COPY tsconfig.json ./
COPY --chown=pwuser:pwuser . .

# Persistent volume for run artifacts (per-job JSON files, PDFs, etc.)
VOLUME ["/app/.artifacts"]

# Defaults — override at runtime via -e
ENV NODE_ENV=production \
    HEADLESS=true \
    MCA_FILING_PORT=8090 \
    MCA_FILING_ARTIFACT_DIR=/app/.artifacts/runs \
    MAX_CONCURRENT_JOBS=5

# Drop to pwuser (set up by the playwright base image)
USER pwuser

EXPOSE 8090

# Health check — hits /health every 30s
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8090/health || exit 1

CMD ["npx", "tsx", "src/server/index.ts"]
