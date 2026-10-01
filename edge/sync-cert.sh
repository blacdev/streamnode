#!/usr/bin/env bash
# Copies the gateway's certificate to this edge server and reloads HAProxy if
# it changed. Every server answering for the domain must present the same
# certificate; the main gateway obtains and renews it.
#
#   edge/sync-cert.sh          copy now (run once before the first start)
#
# Run it daily from cron so renewals reach this server:
#   43 3 * * * /path/to/radio-gateway/edge/sync-cert.sh >> /path/to/radio-gateway/edge/sync-cert.log 2>&1
#
# Needs SSH key access from this server to the gateway (CERT_SOURCE in edge/.env).
set -euo pipefail
cd "$(dirname "$0")"

SOURCE="$(grep '^CERT_SOURCE=' .env | head -n1 | cut -d= -f2-)"
[ -n "$SOURCE" ] || { echo "CERT_SOURCE is not set in edge/.env" >&2; exit 1; }
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi

mkdir -p certs
tmp="$(mktemp certs/.stream.pem.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
scp -q -o BatchMode=yes "$SOURCE" "$tmp"
grep -q "BEGIN CERTIFICATE" "$tmp" && grep -q "PRIVATE KEY" "$tmp" || { echo "The copied file is not a certificate plus key." >&2; exit 1; }
chmod 600 "$tmp"

if [ -f certs/stream.pem ] && cmp -s "$tmp" certs/stream.pem; then
  echo "Certificate unchanged."
  exit 0
fi
mv "$tmp" certs/stream.pem
trap - EXIT
echo "Certificate updated ($(openssl x509 -enddate -noout -in certs/stream.pem 2>/dev/null || echo 'expiry unknown'))."
# Reload only if HAProxy is already running; listeners stay connected.
if [ -n "$($COMPOSE ps -q haproxy_edge 2>/dev/null)" ]; then
  $COMPOSE kill -s HUP haproxy_edge
  echo "HAProxy reloaded."
fi
