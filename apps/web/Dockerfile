# syntax=docker/dockerfile:1.7

# ---- build: compile the SPA ----
FROM node:26-slim AS build
WORKDIR /app
# Dependencies only. This layer is reused until the lockfile changes,
# and the cache mount keeps npm's download cache between builds.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY . .
# The Firebase web config comes from .env.production. A build arg overrides it, e.g. to point a
# staging build at another Firebase project. No defaults: an empty ARG would override the file.
# hadolint ignore=DL3064
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_AUTH_DOMAIN
RUN npm run build

# ---- runtime: static files on unprivileged nginx (runs as non-root on 8080) ----
FROM nginxinc/nginx-unprivileged:1.30-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.inc /etc/nginx/conf.d/security-headers.inc
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
