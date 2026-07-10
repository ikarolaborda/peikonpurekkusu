# syntax=docker/dockerfile:1.7
# Build context: repo root (dockerfile: frontend/Dockerfile)

FROM node:24-slim AS build
WORKDIR /app
RUN npm i -g pnpm@9.15.0
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-fe,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY frontend/ .
RUN pnpm test && pnpm build

FROM nginxinc/nginx-unprivileged:1.29-alpine
# application builder output lives under dist/<project>/browser
COPY --from=build /app/dist/peikon-frontend/browser /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
