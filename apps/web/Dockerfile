# syntax=docker/dockerfile:1.7

# ---- build: compile the SPA ----
FROM node:22-slim AS build
WORKDIR /app
# Dependencies only. This layer is reused until the lockfile changes,
# and the cache mount keeps npm's download cache between builds.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime: static files on unprivileged nginx (runs as non-root on 8080) ----
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
