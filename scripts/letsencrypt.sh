#!/usr/bin/env bash
# Optional Let's Encrypt certificate for the gateway.
#
#   scripts/letsencrypt.sh issue    obtain a certificate for DOMAIN in .env
#   scripts/letsencrypt.sh renew    renew if due (run this daily from cron)
#
# The gateway must already be running: HAProxy forwards the HTTP-01 challenge
# on port 80 to a short-lived certbot container. DOMAIN must resolve to this
# server and port 80 must be reachable from the internet.
set -euo pipefail
cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi
get_env() { grep "^$1=" .env | head -n1 | cut -d= -f2-; }
DOMAIN="$(get_env DOMAIN)"
EMAIL="$(get_env LETSENCRYPT_EMAIL)"
[ -n "$DOMAIN" ] || { echo "DOMAIN is not set in .env" >&2; exit 1; }

# HAProxy wants the chain and key in one file. Written to a temp name and
# moved into place so HAProxy never reads a half-written certificate.
HOOK='cat "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" > /certs/stream.pem.new && chmod 600 /certs/stream.pem.new && mv /certs/stream.pem.new /certs/stream.pem && touch /certs/.renewed'
certbot() { $COMPOSE --profile letsencrypt run --rm --use-aliases certbot "$@"; }

reload_if_renewed() {
  if [ -e certs/.renewed ]; then
    $COMPOSE run --rm --no-deps --entrypoint rm certbot -f /certs/.renewed >/dev/null 2>&1 || rm -f certs/.renewed
    # A reload starts new workers with the new certificate; listeners already
    # connected stay on the old workers and are not interrupted.
    $COMPOSE kill -s HUP haproxy_edge
    echo "Certificate installed and HAProxy reloaded."
  fi
}

case "${1:-}" in
  issue)
    [ -n "$EMAIL" ] || { echo "Set LETSENCRYPT_EMAIL in .env (or pass --email to install.sh)." >&2; exit 1; }
    certbot certonly --standalone --http-01-port 8888 --non-interactive --agree-tos \
      -m "$EMAIL" -d "$DOMAIN" --keep-until-expiring --deploy-hook "$HOOK"
    reload_if_renewed
    echo "To renew automatically, add this line with 'crontab -e':"
    echo "  17 3 * * * $(pwd)/scripts/letsencrypt.sh renew >> $(pwd)/letsencrypt.log 2>&1"
    ;;
  renew)
    certbot renew --standalone --http-01-port 8888 --non-interactive --deploy-hook "$HOOK"
    reload_if_renewed
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
