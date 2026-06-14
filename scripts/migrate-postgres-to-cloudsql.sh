#!/usr/bin/env bash
# scripts/migrate-postgres-to-cloudsql.sh
# Dump an existing local/legacy Postgres database and load it into Cloud SQL.
#
# Prerequisites:
#   • Local pg_dump installed (Postgres client tools)
#   • Cloud SQL Auth Proxy installed:
#       https://cloud.google.com/sql/docs/postgres/connect-auth-proxy
#   • Cloud SQL instance already created with an EMPTY database named ${TARGET_DB}
#   • A Cloud SQL user (${TARGET_USER}) with full rights on ${TARGET_DB}
#
# Usage:
#   SOURCE_URL="postgresql://user:pw@localhost:5432/mitra" \
#   CLOUD_SQL_INSTANCE="my-project:asia-south1:mitra-db" \
#   TARGET_DB="mitra" \
#   TARGET_USER="mitra_app" \
#   TARGET_PASSWORD="..."  ./scripts/migrate-postgres-to-cloudsql.sh

set -euo pipefail

: "${SOURCE_URL:?SOURCE_URL is required (e.g. postgresql://user:pw@host:5432/db)}"
: "${CLOUD_SQL_INSTANCE:?CLOUD_SQL_INSTANCE is required (project:region:instance)}"
: "${TARGET_DB:?TARGET_DB is required}"
: "${TARGET_USER:?TARGET_USER is required}"
: "${TARGET_PASSWORD:?TARGET_PASSWORD is required}"

DUMP_FILE="${DUMP_FILE:-./mitra-dump-$(date +%Y%m%d-%H%M%S).sql}"
PROXY_PORT="${PROXY_PORT:-5433}"

echo "📦 1/3 Dumping source database…"
pg_dump --no-owner --no-acl --clean --if-exists \
  --format=plain --file="$DUMP_FILE" \
  "$SOURCE_URL"
echo "   → $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

echo "🔌 2/3 Starting Cloud SQL Auth Proxy on 127.0.0.1:${PROXY_PORT}…"
if ! command -v cloud-sql-proxy >/dev/null; then
  echo "cloud-sql-proxy not found. Install: https://cloud.google.com/sql/docs/postgres/connect-auth-proxy" >&2
  exit 1
fi
cloud-sql-proxy --port "$PROXY_PORT" "$CLOUD_SQL_INSTANCE" &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
sleep 4

echo "📥 3/3 Restoring into Cloud SQL…"
PGPASSWORD="$TARGET_PASSWORD" psql \
  --host=127.0.0.1 --port="$PROXY_PORT" \
  --username="$TARGET_USER" \
  --dbname="$TARGET_DB" \
  --single-transaction \
  --set ON_ERROR_STOP=on \
  --file="$DUMP_FILE"

echo "✅ Migration complete. Run 'npm run migrate' next to apply new schema changes."
