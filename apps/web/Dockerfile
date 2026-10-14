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
# Firebase *web* config, baked into the bundle (public by design, not secrets). Leave the key
# empty and the site works without admin sign-in. On CloudApps set it as a BuildConfig build arg.
# The Firebase web API key identifies the project and ships to every browser; not a secret.
# hadolint ignore=DL3064
ARG VITE_FIREBASE_API_KEY=""
ARG VITE_FIREBASE_PROJECT_ID="comp523"
ARG VITE_FIREBASE_AUTH_DOMAIN=""
RUN npm run build

# ---- runtime: static files on unprivileged nginx (runs as non-root on 8080) ----
FROM nginxinc/nginx-unprivileged:1.30-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.inc /etc/nginx/conf.d/security-headers.inc
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
