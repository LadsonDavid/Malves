# Build from the repository root:
#   docker build -f packages/relay/Dockerfile -t malves-relay .
# If Docker Hub rate-limits you, add: --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/relay packages/relay
RUN pnpm install --filter @malves/relay --frozen-lockfile \
 && pnpm --filter @malves/relay build \
 && pnpm --filter @malves/relay deploy --legacy --prod /out

FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=build /out /app
USER node
ENV RELAY_HOST=0.0.0.0 RELAY_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "/app/dist/main.js"]
