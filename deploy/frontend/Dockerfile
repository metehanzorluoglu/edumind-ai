# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder

WORKDIR /workspace

# ------------------------------------------------------------
# Build education-assistant-client
# ------------------------------------------------------------

COPY packages/education-assistant-client/package.json \
  packages/education-assistant-client/package.json

COPY packages/education-assistant-client/package-lock.json* \
  packages/education-assistant-client/

COPY packages/education-assistant-client/ \
  packages/education-assistant-client/

WORKDIR /workspace/packages/education-assistant-client

RUN if [ -f package-lock.json ]; then \
  npm ci --no-audit --no-fund; \
  else \
  npm install --no-audit --no-fund; \
  fi

RUN npm run build

RUN test -f dist/index.js && test -f dist/index.d.ts

# ------------------------------------------------------------
# Install and export Expo frontend
# ------------------------------------------------------------

WORKDIR /workspace

COPY examples/expo-education-assistant/package.json \
  examples/expo-education-assistant/package.json

COPY examples/expo-education-assistant/package-lock.json \
  examples/expo-education-assistant/package-lock.json

WORKDIR /workspace/examples/expo-education-assistant

RUN npm ci --no-audit --no-fund

WORKDIR /workspace

COPY examples/expo-education-assistant/ \
  examples/expo-education-assistant/

ARG EXPO_PUBLIC_API_BASE_URL
ENV EXPO_PUBLIC_API_BASE_URL=${EXPO_PUBLIC_API_BASE_URL}

WORKDIR /workspace/examples/expo-education-assistant

RUN npx expo export --platform web

# ------------------------------------------------------------
# Production nginx
# ------------------------------------------------------------

FROM nginx:1.27-alpine

COPY deploy/frontend/nginx.conf \
  /etc/nginx/conf.d/default.conf

COPY --from=builder \
  /workspace/examples/expo-education-assistant/dist \
  /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health || exit 1