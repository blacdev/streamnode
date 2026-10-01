#!/usr/bin/env bash
# Restores a dump made by scripts/backup.sh, replacing the current database.
#
#   scripts/restore.sh backups/gateway-20260101-030000.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -eq 1 ] && [ -f "$1" ] || { echo "Usage: scripts/restore.sh <dump.sql.gz>" >&2; exit 1; }
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi

read -r -p "This replaces ALL current stations, accounts and statistics with $1. Type 'restore' to continue: " answer
[ "$answer" = "restore" ] || { echo "Cancelled."; exit 1; }

$COMPOSE stop admin_dashboard
gunzip -c "$1" | $COMPOSE exec -T postgres_db sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
# On start the admin service republishes every station to the engine.
$COMPOSE start admin_dashboard
echo "Restore complete."
