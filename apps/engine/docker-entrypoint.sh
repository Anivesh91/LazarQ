#!/bin/sh
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[engine-entrypoint] Applying Prisma database migrations..."
  ./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma
fi

if [ "${SEED_RUNBOOKS:-false}" = "true" ]; then
  echo "[engine-entrypoint] Seeding default troubleshooting runbooks..."
  node apps/engine/dist/db/seed-runbooks.js
fi

exec "$@"
