#!/usr/bin/env bash
# Installs the radio gateway on this server in one of three roles.
#
#   both     everything on one server: use this when a single server is all you need
#   master   HAProxy, dashboard/API and databases: the public entry point that
#            spreads listeners across slave nodes
#   slave    the audio engine only: joins a master and takes a share of listeners
#
# Usage:
#   ./install.sh                                          asks which role, then for what it needs
#   ./install.sh --role both   --domain stream.example.com --tls letsencrypt --email you@example.com
#   ./install.sh --role master --domain stream.example.com --tls provided --cert fullchain.pem --key privkey.pem
#   ./install.sh --role slave  --master https://stream.example.com --token rgj_...
#   ./install.sh --role slave                             installs and waits; finish from the master's dashboard
#
# Certificate for the domain (master and both), --tls:
#   letsencrypt   obtain and renew one automatically (needs --email)
#   provided      use your own certificate: --cert FILE [--key FILE]
#   external      HTTPS is handled in front of this server (a load balancer or
#                 proxy holds the certificate); this server is reached over HTTP
#   selfsigned    a temporary certificate, for testing
#   --cluster-host ADDRESS   address slave nodes use to reach this master directly,
#                            when the domain points at something in front of it
#
# Slave options:
#   --name NAME          name shown on the master (default: this server's hostname)
#   --advertise ADDRESS  address the master should use to reach this server
#                        (default: the address the master sees the join request come from)
#   --engine-port PORT   port the engine listens on (default: 3000)
#   --insecure           accept a master whose certificate cannot be verified (self-signed)
#
# Images (every role):
#   --build-from-source  compile the images on this server instead of downloading
#                        the prebuilt ones (needs about 2 GB of memory)
#   --image-tag TAG      prebuilt version to run: "latest" or a release such as v2.4.0
#
# Safe to re-run: existing secrets and certificates are kept, and the newest
# images for the chosen tag are downloaded.
set -euo pipefail
cd "$(dirname "$0")"

ROLE="" DOMAIN="" EMAIL="" TLS="" CERT="" KEY="" CLUSTER_HOST=""
MASTER="" TOKEN="" NAME="" ADVERTISE="" ENGINE_PORT="" INSECURE=false
FROM_SOURCE=false IMAGE_TAG_ARG=""

usage() { sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; }
fail() { echo "Error: $*" >&2; exit 1; }
need_value() { [ $# -ge 2 ] || fail "$1 needs a value."; }

while [ $# -gt 0 ]; do
  case "$1" in
    --role) need_value "$@"; ROLE="$2"; shift 2 ;;
    --domain) need_value "$@"; DOMAIN="$2"; shift 2 ;;
    --email) need_value "$@"; EMAIL="$2"; shift 2 ;;
    --letsencrypt) TLS=letsencrypt; shift ;;
    --tls) need_value "$@"; TLS="$2"; shift 2 ;;
    --cert) need_value "$@"; CERT="$2"; shift 2 ;;
    --key) need_value "$@"; KEY="$2"; shift 2 ;;
    --cluster-host) need_value "$@"; CLUSTER_HOST="$2"; shift 2 ;;
    --master) need_value "$@"; MASTER="$2"; shift 2 ;;
    --token) need_value "$@"; TOKEN="$2"; shift 2 ;;
    --name) need_value "$@"; NAME="$2"; shift 2 ;;
    --advertise) need_value "$@"; ADVERTISE="$2"; shift 2 ;;
    --engine-port) need_value "$@"; ENGINE_PORT="$2"; shift 2 ;;
    --insecure) INSECURE=true; shift ;;
    --build-from-source) FROM_SOURCE=true; shift ;;
    --image-tag) need_value "$@"; IMAGE_TAG_ARG="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1 (see ./install.sh --help)" ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────────────

random() { # random HEX_BYTES
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
get_env() { [ -f .env ] && grep "^$1=" .env | head -n1 | cut -d= -f2- || true; }
set_env() { # set_env KEY VALUE: add or replace one line in .env
  local tmp; tmp="$(mktemp)"
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}
ensure_env() { [ -n "$(get_env "$1")" ] || set_env "$1" "$2"; }

# The registry holding the prebuilt images: the one written into .env.example
# when the project was published, else derived from where this copy was cloned.
default_image_prefix() {
  local prefix remote
  prefix="$(grep '^IMAGE_PREFIX=' .env.example 2>/dev/null | head -n1 | cut -d= -f2-)"
  case "$prefix" in ""|*OWNER/REPO*) prefix="" ;; esac
  if [ -z "$prefix" ] && command -v git >/dev/null 2>&1; then
    remote="$(git remote get-url origin 2>/dev/null || true)"
    case "$remote" in
      *github.com[:/]*)
        remote="${remote#*github.com[:/]}"; remote="${remote%.git}"
        prefix="ghcr.io/$(printf '%s' "$remote" | tr '[:upper:]' '[:lower:]')" ;;
    esac
  fi
  printf '%s' "$prefix"
}

# Records where images come from; called once .env exists.
configure_images() {
  ensure_env IMAGE_TAG latest
  [ -z "$IMAGE_TAG_ARG" ] || set_env IMAGE_TAG "$IMAGE_TAG_ARG"
  case "$(get_env IMAGE_PREFIX)" in ""|*OWNER/REPO*) set_env IMAGE_PREFIX "$(default_image_prefix)" ;; esac
  if $FROM_SOURCE; then set_env INSTALL_FROM source
  elif [ -z "$(get_env IMAGE_PREFIX)" ]; then set_env INSTALL_FROM source
  else ensure_env INSTALL_FROM images; fi
  # Built images need a name too.
  [ -n "$(get_env IMAGE_PREFIX)" ] || set_env IMAGE_PREFIX radio-gateway
}

# Downloads the prebuilt images and starts the services; compiles from source
# when asked to, or when the images cannot be downloaded.
start_services() {
  if [ "$(get_env INSTALL_FROM)" = source ]; then
    echo "Building the images from source (several minutes; needs about 2 GB of memory)..."
    $COMPOSE up --build -d
    return
  fi
  echo "Downloading the images ($(get_env IMAGE_PREFIX), tag $(get_env IMAGE_TAG))..."
  local problem
  if problem="$($COMPOSE pull --quiet 2>&1)"; then
    $COMPOSE up -d --no-build
  else
    echo "The prebuilt images could not be downloaded:"
    printf '%s\n' "$problem" | tail -n 2 | sed 's/^/  /'
    echo "Building from source instead (several minutes; needs about 2 GB of memory)."
    echo "For a private registry, sign in first (docker login ghcr.io) and run this again."
    $COMPOSE up --build -d
  fi
}

# ── Requirements ───────────────────────────────────────────────────────────

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. See https://docs.docker.com/engine/install/"
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else fail "Docker Compose is not installed."; fi
docker info >/dev/null 2>&1 || fail "Cannot talk to the Docker daemon. Run this script as root or as a member of the docker group."

# ── Role ───────────────────────────────────────────────────────────────────

EXISTING_ROLE="$(get_env ROLE)"
if [ -z "$ROLE" ] && [ -n "$EXISTING_ROLE" ]; then
  ROLE="$EXISTING_ROLE"
  echo "This server is already set up as: $ROLE"
fi
if [ -z "$ROLE" ]; then
  [ -t 0 ] || fail "Choose a role: --role both | master | slave"
  cat <<'EOF'
What should this server be?

  1) Both    Everything on this one server. Choose this if one server is all you need.
  2) Master  The public entry point: HAProxy, dashboard, API and databases.
             Audio is relayed by slave nodes that you add afterwards.
  3) Slave   An audio engine that joins an existing master and shares its listeners.

EOF
  read -r -p "Enter 1, 2 or 3: " choice
  case "$choice" in
    1|both|Both) ROLE=both ;;
    2|master|Master) ROLE=master ;;
    3|slave|Slave) ROLE=slave ;;
    *) fail "Not a valid choice." ;;
  esac
fi
case "$ROLE" in both|master|slave) ;; *) fail "--role must be both, master or slave." ;; esac
if [ -n "$EXISTING_ROLE" ] && [ "$EXISTING_ROLE" != "$ROLE" ]; then
  fail "This server is already installed as \"$EXISTING_ROLE\". To change its role see docs/INSTALLATION.md (Changing a server's role)."
fi

# ── Slave node ─────────────────────────────────────────────────────────────

install_slave() {
  local fresh=false
  if [ -z "$MASTER" ] && [ -z "$TOKEN" ] && [ ! -f .env ] && [ -t 0 ]; then
    echo "To join now you need the master's address and a join token"
    echo "(on the master: dashboard > Servers > Add server, or scripts/add-server.sh)."
    read -r -p "Master address (leave empty to finish from the master's dashboard instead): " MASTER
    if [ -n "$MASTER" ]; then read -r -p "Join token: " TOKEN; fi
  fi
  if [ -n "$MASTER" ] && [ -z "$TOKEN" ]; then fail "--master needs --token. Create one on the master: scripts/add-server.sh"; fi
  if [ -n "$TOKEN" ] && [ -z "$MASTER" ]; then fail "--token needs --master (the master's address)."; fi
  case "$MASTER" in ""|http://*|https://*) ;; *) MASTER="https://$MASTER" ;; esac
  MASTER="${MASTER%/}"

  if [ ! -f .env ]; then
    fresh=true
    [ -n "$NAME" ] || NAME="$(hostname 2>/dev/null | tr -c 'a-zA-Z0-9._-' '-' | sed 's/^-*//; s/-*$//')"
    [ -n "$NAME" ] || NAME="slave-$(random 3)"
    ( umask 077; : > .env )
    set_env ROLE slave
    set_env COMPOSE_PROFILES slave
    set_env NODE_ID "$NAME"
    set_env ENGINE_BIND 0.0.0.0
    set_env ENGINE_PORT "${ENGINE_PORT:-3000}"
    set_env ADVERTISE_ADDRESS "$ADVERTISE"
    set_env NODE_SETUP_KEY "rgn_$(random 24)"
    set_env MASTER_URL ""
    set_env JOIN_TOKEN ""
    set_env ALLOW_INSECURE_TLS "$INSECURE"
    echo "Created .env for a slave node named \"$NAME\"."
  else
    [ -z "$NAME" ] || set_env NODE_ID "$NAME"
    [ -z "$ENGINE_PORT" ] || set_env ENGINE_PORT "$ENGINE_PORT"
    [ -z "$ADVERTISE" ] || set_env ADVERTISE_ADDRESS "$ADVERTISE"
    $INSECURE && set_env ALLOW_INSECURE_TLS true
    echo "Using existing .env."
  fi
  chmod 600 .env
  local port; port="$(get_env ENGINE_PORT)"

  if [ -n "$TOKEN" ]; then
    # Fail early with a clear message rather than leaving the engine retrying.
    if command -v curl >/dev/null 2>&1; then
      if ! curl -fsS -m 15 -o /dev/null "$MASTER/api/v1/health" 2>/dev/null; then
        if curl -fsSk -m 15 -o /dev/null "$MASTER/api/v1/health" 2>/dev/null; then
          [ "$(get_env ALLOW_INSECURE_TLS)" = "true" ] || fail "The master at $MASTER answers, but its certificate cannot be verified (it is probably still self-signed). Install a real certificate on the master, or re-run with --insecure."
        else
          fail "Cannot reach the master at $MASTER. Check the address and that ports 80/443 are open on the master."
        fi
      fi
    fi
    set_env MASTER_URL "$MASTER"
    set_env JOIN_TOKEN "$TOKEN"
    if ! $fresh; then
      # Joining again (a new master, or a revoked enrolment): forget the old one.
      $COMPOSE down -v >/dev/null 2>&1 || true
    fi
  fi

  configure_images
  start_services

  if [ -n "$TOKEN" ]; then
    echo -n "Joining the master"
    local joined=false refused=false
    for _ in $(seq 1 45); do
      logs="$($COMPOSE logs --no-color slave_engine 2>&1 || true)"
      if echo "$logs" | grep -q "audio relay engine listening"; then joined=true; break; fi
      if echo "$logs" | grep -q "refused the join token"; then refused=true; break; fi
      echo -n "."; sleep 2
    done
    echo
    # A join token works once; do not leave it in the settings file.
    set_env JOIN_TOKEN ""
    if $refused; then
      echo "$logs" | grep "refused the join token" | tail -n1 >&2
      fail "The master refused the join token. Create a new one on the master (scripts/add-server.sh) and run this command again with it."
    fi
    $joined || fail "The engine did not finish joining. Inspect it with: $COMPOSE logs slave_engine"
    cat <<EOF

This server has joined $MASTER as "$(get_env NODE_ID)".
It appears under Servers on the master's dashboard and receives listeners as
soon as the master's health check passes (a few seconds).

Firewall: allow TCP port $port from the master only. Listeners never connect
to this server directly; the engine refuses requests that do not come from
the master.
EOF
  else
    local address; address="$(get_env ADVERTISE_ADDRESS)"
    [ -n "$address" ] || address="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$address" ] || address="ADDRESS-OF-THIS-SERVER"
    cat <<EOF

The audio engine is installed and waiting to be connected to a master.

On the master's dashboard open Servers > Add server > "The slave is already
installed" and enter:

  Server address   $address
  Engine port      $port
  Setup key        $(get_env NODE_SETUP_KEY)

or, with the API:

  curl -X POST https://<master>/api/v1/servers -H "X-API-Key: <key>" \\
       -H "Content-Type: application/json" \\
       -d '{"host": "$address", "port": $port, "setup_key": "$(get_env NODE_SETUP_KEY)"}'

Firewall: allow TCP port $port from the master only.
If the master still uses a self-signed certificate, re-run this script with --insecure first.
EOF
  fi
}

# ── Master node, or both on one server ─────────────────────────────────────

install_master() {
  command -v openssl >/dev/null 2>&1 || fail "openssl is not installed."
  local created=false
  if [ ! -f .env ]; then
    created=true
    if [ -z "$DOMAIN" ] && [ -t 0 ]; then
      read -r -p "Public hostname of the gateway (e.g. stream.example.com): " DOMAIN
    fi
    [ -n "$DOMAIN" ] || fail "A hostname is required. Pass --domain stream.example.com"
    ( umask 077; cp .env.example .env )
    set_env ROLE "$ROLE"
    set_env DOMAIN "$DOMAIN"
    set_env PUBLIC_BASE_URL "https://$DOMAIN"
    set_env POSTGRES_PASSWORD "$(random 24)"
    set_env REDIS_PASSWORD "$(random 24)"
    set_env ENGINE_SECRET "$(random 24)"
    set_env ADMIN_PASSWORD "$(random 12)"
    set_env ADMIN_API_KEY "rgw_$(random 24)"
    [ -z "$EMAIL" ] || set_env LETSENCRYPT_EMAIL "$EMAIL"
    echo "Created .env with generated secrets."
  else
    [ -z "$DOMAIN" ] || { set_env DOMAIN "$DOMAIN"; set_env PUBLIC_BASE_URL "https://$DOMAIN"; }
    [ -z "$EMAIL" ] || set_env LETSENCRYPT_EMAIL "$EMAIL"
    echo "Using existing .env."
  fi
  if [ "$ROLE" = master ]; then
    set_env COMPOSE_PROFILES master
    set_env LOCAL_ENGINE ""
    # Slave nodes reach Redis here, over TLS and with the Redis password.
    ensure_env CLUSTER_BIND 0.0.0.0
    [ "$(get_env CLUSTER_BIND)" != "127.0.0.1" ] || set_env CLUSTER_BIND 0.0.0.0
  else
    set_env COMPOSE_PROFILES master,local-engine
    set_env LOCAL_ENGINE audio_engine:3000
    ensure_env CLUSTER_BIND 127.0.0.1
  fi
  [ -z "$CLUSTER_HOST" ] || set_env CLUSTER_HOST "$CLUSTER_HOST"

  # Where the domain's certificate comes from.
  [ -z "$CERT" ] || [ -n "$TLS" ] || TLS=provided
  if [ -z "$TLS" ] && [ -z "$(get_env TLS_MODE)" ]; then
    if [ -t 0 ]; then
      cat <<'EOF'

How is HTTPS for this domain provided?

  1) Let's Encrypt   Obtain a free certificate now and renew it automatically.
  2) My own          I have certificate files to use.
  3) Elsewhere       A load balancer or proxy in front of this server holds the
                     certificate and forwards plain HTTP to it.
  4) None yet        Use a temporary self-signed certificate (testing only).

EOF
      read -r -p "Enter 1, 2, 3 or 4: " choice
      case "$choice" in
        1) TLS=letsencrypt ;; 2) TLS=provided ;; 3) TLS=external ;; 4) TLS=selfsigned ;;
        *) fail "Not a valid choice." ;;
      esac
    else
      TLS=selfsigned
    fi
  fi
  [ -n "$TLS" ] || TLS="$(get_env TLS_MODE)"
  case "$TLS" in letsencrypt|provided|external|selfsigned) ;; *) fail "--tls must be letsencrypt, provided, external or selfsigned." ;; esac

  if [ "$TLS" = letsencrypt ] && [ -z "$(get_env LETSENCRYPT_EMAIL)" ]; then
    if [ -t 0 ]; then read -r -p "Email address for Let's Encrypt expiry notices: " EMAIL; fi
    [ -n "$EMAIL" ] || fail "Let's Encrypt needs a contact address: --email you@example.com"
    set_env LETSENCRYPT_EMAIL "$EMAIL"
  fi
  mkdir -p certs
  if [ "$TLS" = provided ]; then
    if [ -z "$CERT" ] && [ ! -s certs/stream.pem ] && [ -t 0 ]; then
      read -r -p "Certificate file (full chain, PEM): " CERT
      read -r -p "Private key file (leave empty if it is in the same file): " KEY
    fi
    if [ -n "$CERT" ]; then
      [ -r "$CERT" ] || fail "Cannot read the certificate file: $CERT"
      [ -z "$KEY" ] || [ -r "$KEY" ] || fail "Cannot read the key file: $KEY"
      local combined; combined="$(mktemp)"
      cat "$CERT" ${KEY:+"$KEY"} > "$combined"
      grep -q "BEGIN CERTIFICATE" "$combined" || { rm -f "$combined"; fail "$CERT does not contain a PEM certificate."; }
      grep -q "PRIVATE KEY" "$combined" || { rm -f "$combined"; fail "No private key found. Pass it with --key FILE."; }
      openssl x509 -in "$combined" -noout >/dev/null 2>&1 || { rm -f "$combined"; fail "The certificate could not be parsed."; }
      ( umask 077; cat "$combined" > certs/stream.pem ); rm -f "$combined"
      echo "Installed your certificate (valid until $(openssl x509 -in certs/stream.pem -noout -enddate | cut -d= -f2-))."
    elif [ ! -s certs/stream.pem ]; then
      fail "--tls provided needs --cert FILE (and --key FILE unless the key is in the same file)."
    fi
  fi
  set_env TLS_MODE "$TLS"

  # Settings introduced after an older .env was written.
  ensure_env REDIS_PASSWORD "$(random 24)"
  ensure_env ENGINE_SECRET "$(random 24)"
  ensure_env CLUSTER_PORT 6380
  chmod 600 .env
  DOMAIN="$(get_env DOMAIN)"

  # HAProxy needs some certificate to start, whatever the mode: a self-signed
  # one stands in until Let's Encrypt has issued (or for good, when HTTPS is
  # handled in front of this server).
  if [ ! -s certs/stream.pem ]; then
    echo "Generating a self-signed certificate for $DOMAIN."
    local tmp; tmp="$(mktemp -d)"
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=DNS:$DOMAIN" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1
    ( umask 077; cat "$tmp/cert.pem" "$tmp/key.pem" > certs/stream.pem )
    rm -rf "$tmp"
  fi

  configure_images
  start_services

  echo "Waiting for the gateway to become healthy..."
  local ready=false
  for _ in $(seq 1 60); do
    if $COMPOSE exec -T admin_dashboard wget -q -O /dev/null http://127.0.0.1:8000/api/v1/health 2>/dev/null; then
      ready=true; break
    fi
    sleep 3
  done
  $ready || fail "The management API did not become healthy. Inspect it with: $COMPOSE logs admin_dashboard"

  if [ "$TLS" = letsencrypt ]; then ./scripts/letsencrypt.sh issue; fi

  echo
  echo "The gateway is running ($ROLE)."
  echo "  Dashboard:  https://$DOMAIN/admin/"
  echo "  API docs:   https://$DOMAIN/api/v1/docs"
  echo "  Streams:    http(s)://$DOMAIN/<station-slug>"
  echo "  Sign in as: $(get_env ADMIN_USERNAME)"
  if $created; then
    echo "  Password:   $(get_env ADMIN_PASSWORD)"
    echo "  API key:    $(get_env ADMIN_API_KEY)"
    echo "These were generated just now and are stored in .env. Keep that file private."
  else
    echo "  Password and API key are in .env."
  fi
  case "$TLS" in
    external)
      echo
      echo "HTTPS is handled in front of this server. Point your load balancer or proxy at"
      echo "this server's port $(get_env HTTP_PORT) over plain HTTP. It must add X-Forwarded-For, must not"
      echo "buffer responses, and must allow long-lived connections. Allow port $(get_env HTTP_PORT) from it only."
      if [ -z "$(get_env CLUSTER_HOST)" ]; then
        echo "Before adding slave nodes, set CLUSTER_HOST in .env to an address that reaches"
        echo "this server directly (they connect to it on port $(get_env CLUSTER_PORT)), then: $COMPOSE up -d"
      fi ;;
    selfsigned)
      echo
      echo "This server uses a temporary self-signed certificate. For a real one, re-run with"
      echo "--tls letsencrypt --email you@example.com, or --tls provided --cert FILE --key FILE." ;;
  esac
  echo
  if [ "$ROLE" = master ]; then
    echo "This master relays no audio by itself. Add at least one slave node:"
    echo
    ./scripts/add-server.sh || echo "  (could not create a join command; run scripts/add-server.sh later)"
    echo
    if [ "$TLS" = external ]; then
      echo "Firewall: open TCP $(get_env HTTP_PORT) to the proxy in front, and TCP $(get_env CLUSTER_PORT) to your slave nodes."
    else
      echo "Firewall: open TCP 80 and 443 to everyone, and TCP $(get_env CLUSTER_PORT) to your slave nodes."
    fi
  else
    echo "To add more servers later, see docs/SCALING.md (in short: scripts/add-server.sh)."
  fi
}

if [ "$ROLE" = slave ]; then install_slave; else install_master; fi
