FROM node:22-slim AS base
WORKDIR /app

FROM base AS builder
RUN npm install -g pnpm@12.15.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/engine/package.json ./apps/engine/package.json
COPY apps/playground/package.json ./apps/playground/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json

RUN pnpm install --filter @dlq-healer/dashboard --frozen-lockfile

COPY apps/dashboard ./apps/dashboard
RUN mkdir -p apps/dashboard/public

ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT_STANDALONE=true

RUN pnpm --filter @dlq-healer/dashboard build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=node:node /app/apps/dashboard/public ./apps/dashboard/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/operator/session').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/dashboard/server.js"]
