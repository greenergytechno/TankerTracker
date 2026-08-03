#!/bin/sh
# Migrate, then start the API. The DB is already healthy (compose depends_on),
# so migrations can run immediately. migrate.js is idempotent — it tracks
# applied files in schema_migrations, so restarts are safe.
set -e

echo "[entrypoint] running migrations..."
node scripts/migrate.js

echo "[entrypoint] starting API..."
exec node dist/main.js
