# Build and test the SDK monorepo (governance + governance-platform).
# Use for CI or as a base image. Not required for running the API (API pulls packages from registry).

# ─── Builder ────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
ARG NODE_AUTH_TOKEN
RUN if [ -n "$NODE_AUTH_TOKEN" ]; then \
      echo "@lua-ai-global:registry=https://npm.pkg.github.com" > .npmrc && \
      echo "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}" >> .npmrc; \
    fi && \
    npm ci 2>/dev/null || npm install && \
    rm -f .npmrc

COPY packages ./packages/
RUN npm run build

# ─── Test (optional: docker build --target test) ────────────────
FROM builder AS test
RUN npm test

# ─── Runtime ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/packages/governance/dist ./packages/governance/dist/
COPY --from=builder /app/packages/governance/package.json ./packages/governance/
COPY --from=builder /app/packages/governance-platform/dist ./packages/governance-platform/dist/
COPY --from=builder /app/packages/governance-platform/package.json ./packages/governance-platform/

USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "process.exit(0)"

EXPOSE 4000
