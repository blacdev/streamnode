#!/usr/bin/env bash
# Writes a compressed PostgreSQL dump to backups/. Everything that must
# survive lives in PostgreSQL; Redis is rebuilt from it on start-up.
#
#   scripts/backup.sh            create backups/gateway-YYYYmmdd-HHMMSS.sql.gz
#   KEEP_DAYS=30 scripts/backup.sh   also delete dumps older than 30 days
set -euo pipefail
cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi
mkdir -p backups
out="backups/gateway-$(date +%Y%m%d-%H%M%S).sql.gz"
( umask 077
  $COMPOSE exec -T postgres_db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' | gzip > "$out" )
echo "Wrote $out"
if [ -n "${KEEP_DAYS:-}" ]; then
  find backups -name 'gateway-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
fi
