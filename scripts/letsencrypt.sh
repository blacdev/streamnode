#!/usr/bin/env bash
# Let's Encrypt certificate for the gateway (TLS_MODE=letsencrypt in .env).
#
#   scripts/letsencrypt.sh issue             obtain a certificate for DOMAIN now
#   scripts/letsencrypt.sh renew [--force]   renew if it expires within 30 days (--force: now)
#   scripts/letsencrypt.sh status            show the certificate HTTPS is served with
#   scripts/letsencrypt.sh schedule install|remove   add or remove the scheduler entry (cron)
#   scripts/letsencrypt.sh tick              what the scheduler runs
#
# Let's Encrypt confirms that this server answers for DOMAIN by fetching a file
# from http://DOMAIN/.well-known/acme-challenge/ on port 80. HAProxy hands those
# requests to the dashboard service, which serves the files certbot writes. So
# DOMAIN must resolve to this server and port 80 must be reachable from the
# internet; the certificate is then served on port 443.
#
# The installer schedules "tick" every 5 minutes. Until a certificate has been
# issued, HTTPS uses a self-signed one and the tick tries again every hour (DNS
# may still be on its way). Afterwards it checks twice a day and renews 30 days
# before expiry. The dashboard (Updates) shows the certificate and can ask for
# a renewal.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"

ACTION="${1:-}"; [ $# -gt 0 ] && shift
SUB="" FORCE=false
while [ $# -gt 0 ]; do
  case "$1" in
    install|remove) SUB="$1"; shift ;;
    --force) FORCE=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi
fail() { echo "Error: $*" >&2; exit 1; }
get_env() { grep "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- || true; }
DOMAIN="$(get_env DOMAIN)"
EMAIL="$(get_env LETSENCRYPT_EMAIL)"
MARK="# streamnode certificate ($DIR)"
WEBROOT=/var/www/acme
# How often the tick tries: while there is no certificate yet (Let's Encrypt
# allows 5 failed attempts per hour), and once there is one.
RETRY_SECS=3600
RENEW_CHECK_SECS=43200

# Shared with the dashboard, like the updater's files: it writes REQUEST
# ("renew now") to cert-settings, this script writes what happened to cert-status.
CONTROL="$DIR/control"
SETTINGS="$CONTROL/cert-settings"
STATUS="$CONTROL/cert-status"
read_kv() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -n1 || true; }
write_kv() {
  local tmp; tmp="$(mktemp "$CONTROL/.tmp.XXXXXX")"
  { [ -f "$1" ] && grep -v "^$2=" "$1" || true; printf '%s=%s\n' "$2" "$3"; } > "$tmp"
  chmod 666 "$tmp" 2>/dev/null || true
  mv "$tmp" "$1"
}
ensure_control() {
  mkdir -p "$CONTROL"
  chmod 777 "$CONTROL" 2>/dev/null || true
}
report() { # report STATE MESSAGE
  ensure_control
  write_kv "$STATUS" STATE "$1"
  write_kv "$STATUS" MESSAGE "$2"
  write_kv "$STATUS" UPDATED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# A short-lived certbot container. It shares a volume with the dashboard
# service, which serves the challenge files from it.
certbot() { $COMPOSE --profile letsencrypt run --rm --no-deps certbot "$@"; }
in_certbot() { local script="$1"; shift; $COMPOSE --profile letsencrypt run --rm --no-deps --entrypoint sh certbot -c "$script" sh "$@"; }

# True when certs/stream.pem is a certificate for DOMAIN from a real authority
# (not self-signed). Read on the host: openssl is required by the installer.
issued() {
  [ -s certs/stream.pem ] && command -v openssl >/dev/null 2>&1 || return 1
  local subject issuer
  subject="$(openssl x509 -in certs/stream.pem -noout -subject 2>/dev/null | sed 's/^subject= *//')"
  issuer="$(openssl x509 -in certs/stream.pem -noout -issuer 2>/dev/null | sed 's/^issuer= *//')"
  [ -n "$issuer" ] && [ "$issuer" != "$subject" ] || return 1
  openssl x509 -in certs/stream.pem -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q "does match"
}
expiry() { openssl x509 -in certs/stream.pem -noout -enddate 2>/dev/null | cut -d= -f2-; }

is_ip() { printf '%s' "$1" | grep -Eq '^[0-9]+(\.[0-9]+){3}$|:'; }

# What can be checked before asking Let's Encrypt, so that a mistake is
# explained here instead of costing one of its limited failed attempts.
preflight() {
  [ -n "$DOMAIN" ] || fail "DOMAIN is not set in .env."
  is_ip "$DOMAIN" && fail "Let's Encrypt issues certificates for domain names only, and DOMAIN is an IP address ($DOMAIN). Run: ./install.sh --domain stream.example.com --tls letsencrypt"
  [ -n "$EMAIL" ] || fail "Set LETSENCRYPT_EMAIL in .env (or run ./install.sh --email you@example.com)."
  [ -n "$($COMPOSE ps -q haproxy_edge 2>/dev/null)" ] \
    || fail "The gateway is not running, so nothing answers Let's Encrypt on port 80. Start it with: $COMPOSE up -d"

  local addresses
  if command -v getent >/dev/null 2>&1; then
    addresses="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
    [ -n "$addresses" ] || fail "$DOMAIN does not resolve to any address. Create a DNS A (and/or AAAA) record pointing $DOMAIN at this server's public address, wait for it to spread, then try again."
    echo "$DOMAIN resolves to: $addresses"
  fi
  local port; port="$(get_env HTTPS_PORT)"
  if [ -n "$port" ] && [ "$port" != 443 ]; then
    echo "Warning: HTTPS is published on port $port (HTTPS_PORT in .env), not 443, so https://$DOMAIN/"
    echo "         does not reach this gateway. Unless something on port 443 forwards to it, set"
    echo "         HTTPS_PORT=443 in .env and run: $COMPOSE up -d"
  fi
  port="$(get_env HTTP_PORT)"
  if [ -n "$port" ] && [ "$port" != 80 ]; then
    echo "Warning: the gateway's HTTP port is $port (HTTP_PORT), but Let's Encrypt always connects to"
    echo "         port 80. That only works if whatever owns port 80 passes /.well-known/acme-challenge/"
    echo "         on to this gateway."
  fi

  # Places a file where Let's Encrypt will look and fetches it the way it will:
  # by name, on port 80. This proves DNS, the firewall and the routing together.
  local token value got
  token="selftest-$(date +%s)-$$"; value="streamnode-$RANDOM$RANDOM"
  in_certbot "mkdir -p $WEBROOT/.well-known/acme-challenge && printf %s $value > $WEBROOT/.well-known/acme-challenge/$token && chmod 644 $WEBROOT/.well-known/acme-challenge/$token" >/dev/null 2>&1 || true
  got="$(curl -sS -m 15 "http://$DOMAIN/.well-known/acme-challenge/$token" 2>&1 || true)"
  in_certbot "rm -f $WEBROOT/.well-known/acme-challenge/$token" >/dev/null 2>&1 || true
  if [ "$got" = "$value" ]; then
    echo "Reached this gateway at http://$DOMAIN/ on port 80: good."
  else
    echo "Warning: http://$DOMAIN/.well-known/acme-challenge/ did not reach this gateway from here"
    echo "         (${got:0:200})."
    echo "         Check that $DOMAIN points at this server and that TCP port 80 is open to the internet"
    echo "         (cloud firewall / security group as well as the server's). Some networks cannot reach"
    echo "         their own public address, so Let's Encrypt is asked anyway."
  fi
}

# Copies the certificate certbot keeps into certs/stream.pem (chain then key,
# as HAProxy wants it) when it differs. Written to a temporary name and moved,
# so HAProxy never reads half a file. Returns 0 if stream.pem changed.
install_cert() {
  local result=0
  in_certbot '
    live=/etc/letsencrypt/live/$1
    [ -s "$live/fullchain.pem" ] && [ -s "$live/privkey.pem" ] || exit 3
    umask 077
    cat "$live/fullchain.pem" "$live/privkey.pem" > /certs/.stream.pem.new
    if cmp -s /certs/.stream.pem.new /certs/stream.pem; then rm -f /certs/.stream.pem.new; exit 1; fi
    mv /certs/.stream.pem.new /certs/stream.pem' "$DOMAIN" || result=$?
  case "$result" in
    0) # A reload starts new workers with the new certificate; listeners already
       # connected stay on the old workers and are not interrupted.
       $COMPOSE kill -s HUP haproxy_edge >/dev/null
       echo "Certificate installed and HAProxy reloaded (valid until $(expiry))."
       return 0 ;;
    1) return 1 ;;
    *) fail "certbot reported success but left no certificate for $DOMAIN." ;;
  esac
}

issue() {
  preflight
  echo "Asking Let's Encrypt for a certificate for $DOMAIN..."
  certbot certonly --webroot -w "$WEBROOT" --cert-name "$DOMAIN" -d "$DOMAIN" \
    --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring \
    || fail "Let's Encrypt did not issue a certificate for $DOMAIN. HTTPS keeps using the current certificate."
  # Also covers a certificate that was issued before but never put in place.
  install_cert || echo "The certificate in use is already the current one (valid until $(expiry))."
}

renew() {
  [ -n "$DOMAIN" ] || fail "DOMAIN is not set in .env."
  local force=""
  if $FORCE; then force=--force-renewal; fi
  certbot renew --cert-name "$DOMAIN" --webroot -w "$WEBROOT" --non-interactive ${force:+"$force"} \
    || fail "The renewal for $DOMAIN failed. HTTPS keeps using the current certificate until $(expiry)."
  install_cert || echo "Not due for renewal; the certificate is valid until $(expiry)."
}

# One pass of the scheduler.
tick() {
  [ "$(get_env TLS_MODE)" = letsencrypt ] || return 0
  ensure_control
  local lock="$CONTROL/.cert.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    [ -z "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ] && return 0
    rmdir "$lock" 2>/dev/null || true; mkdir "$lock" 2>/dev/null || return 0
  fi
  trap 'rmdir "$CONTROL/.cert.lock" 2>/dev/null || true' EXIT
  write_kv "$STATUS" TICK "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local request handled last now why=""
  request="$(read_kv "$SETTINGS" REQUEST)"; handled="$(read_kv "$STATUS" HANDLED_REQUEST)"
  last="$(read_kv "$STATUS" LAST_ATTEMPT)"; now="$(date +%s)"
  if [ "${request:-0}" -gt "${handled:-0}" ] 2>/dev/null; then
    write_kv "$STATUS" HANDLED_REQUEST "$request"
    why="requested from the dashboard"; FORCE=true
  elif ! issued; then
    [ $((now - ${last:-0})) -ge $RETRY_SECS ] || return 0
    why="no certificate yet"
  else
    [ $((now - ${last:-0})) -ge $RENEW_CHECK_SECS ] || return 0
    why="scheduled check"
  fi
  write_kv "$STATUS" LAST_ATTEMPT "$now"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] certificate: $why"

  local output result=0
  report running "Working on the certificate for $DOMAIN ($why)..."
  if issued; then output="$( (renew) 2>&1 )" || result=$?
  else output="$( (issue) 2>&1 )" || result=$?
  fi
  printf '%s\n' "$output"
  if [ "$result" = 0 ]; then
    report ok "$(printf '%s\n' "$output" | tail -n1)"
  else
    # The last lines certbot or this script printed about the problem say why.
    local why_failed
    why_failed="$(printf '%s\n' "$output" | grep -E '^(Error|Hint):|^ +Detail:' | tail -n3 | sed 's/^ *//' | tr '\n' ' ' | cut -c1-600 || true)"
    report failed "${why_failed:-The attempt failed; see letsencrypt.log on the server.}"
  fi
  return 0
}

# Run by hand: the result is recorded for the dashboard too.
by_hand() {
  ensure_control
  write_kv "$STATUS" LAST_ATTEMPT "$(date +%s)"
  if ( "$1" ); then
    report ok "Run by hand on the server: the certificate for $DOMAIN is valid until $(expiry)."
  else
    report failed "Run by hand on the server and failed; run scripts/letsencrypt.sh $1 there to see why."
    exit 1
  fi
}

case "$ACTION" in
  issue|renew) by_hand "$ACTION" ;;
  tick) tick ;;
  status)
    if [ ! -s certs/stream.pem ]; then echo "No certificate in certs/stream.pem."; exit 1; fi
    openssl x509 -in certs/stream.pem -noout -subject -issuer -enddate
    if issued; then echo "Issued for $DOMAIN by a certificate authority."
    else echo "Not a certificate from an authority for $DOMAIN (self-signed, or for another name)."; fi
    if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$MARK"; then echo "Renewal is scheduled."
    else echo "Renewal is NOT scheduled. Fix: scripts/letsencrypt.sh schedule install"; fi ;;
  schedule)
    command -v crontab >/dev/null 2>&1 || fail "cron is not installed on this server (crontab not found), so the certificate cannot be renewed by itself. Install cron, then run: scripts/letsencrypt.sh schedule install"
    current="$(crontab -l 2>/dev/null || true)"
    kept="$(printf '%s\n' "$current" | grep -vF "$MARK" | sed '/^$/d' || true)"
    case "$SUB" in
      install)
        ensure_control
        { [ -z "$kept" ] || printf '%s\n' "$kept"; printf '*/5 * * * * cd %s && ./scripts/letsencrypt.sh tick >> %s/letsencrypt.log 2>&1 %s\n' "$DIR" "$DIR" "$MARK"; } | crontab -
        echo "Certificate renewal is scheduled (checked twice a day, renewed 30 days before expiry)." ;;
      remove)
        printf '%s\n' "$kept" | crontab -
        echo "Certificate renewal is no longer scheduled." ;;
      *) fail "Use: scripts/letsencrypt.sh schedule install|remove" ;;
    esac ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
