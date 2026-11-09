FROM node:22-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS builder
RUN npm install -g pnpm@12.15.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/engine/package.json ./apps/engine/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/playground/package.json ./apps/playground/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY prisma ./prisma

RUN pnpm install --filter . --filter @dlq-healer/engine... --frozen-lockfile

COPY packages/sdk ./packages/sdk
COPY apps/engine ./apps/engine

RUN sed -i 's/\r$//' apps/engine/docker-entrypoint.sh \
  && chmod +x apps/engine/docker-entrypoint.sh

RUN ./node_modules/.bin/prisma generate --schema=./prisma/schema.prisma
RUN pnpm --filter @dlq-healer/sdk build
RUN pnpm --filter @dlq-healer/engine build

FROM base AS runner
ENV NODE_ENV=production
ENV ENGINE_PORT=5000

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=builder --chown=node:node /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder --chown=node:node /app/packages/sdk/node_modules ./packages/sdk/node_modules
COPY --from=builder --chown=node:node /app/apps/engine/package.json ./apps/engine/package.json
COPY --from=builder --chown=node:node /app/apps/engine/dist ./apps/engine/dist
COPY --from=builder --chown=node:node /app/apps/engine/node_modules ./apps/engine/node_modules
COPY --from=builder --chown=node:node /app/apps/engine/docker-entrypoint.sh ./apps/engine/docker-entrypoint.sh

USER node
EXPOSE 5000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.ENGINE_PORT || 5000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["sh", "apps/engine/docker-entrypoint.sh"]
CMD ["node", "apps/engine/dist/server.js"]
