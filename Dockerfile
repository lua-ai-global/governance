# Build and test the SDK monorepo (governance + governance-platform).
# Use for CI or as a base image. Not required for running the API (API pulls packages from registry).
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

# Optional: run tests (override with target)
FROM builder AS test
RUN npm test
