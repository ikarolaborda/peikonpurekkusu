# syntax=docker/dockerfile:1.7
# Build context: repo root (dockerfile: services/notification-service/Dockerfile)

FROM node:24-slim AS build
WORKDIR /app
RUN npm i -g pnpm@9.15.0
COPY services/notification-service/package.json services/notification-service/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-notif,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY services/notification-service/tsconfig.json services/notification-service/tsconfig.spec.json services/notification-service/nest-cli.json ./
COPY services/notification-service/mikro-orm.config.ts ./
COPY services/notification-service/test ./test
COPY services/notification-service/src ./src
RUN pnpm test && pnpm build && pnpm prune --prod

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/src/main.js"]
