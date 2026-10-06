#!/usr/bin/env bash
# Installs StreamNode on this server in one of three roles.
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
#   ./install.sh --role both                              no domain: reached by this server's IP address
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
#   --http-port PORT, --https-port PORT
#                            ports to publish instead of 80 and 443, when another
#                            web server or proxy on this machine already uses them
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
#                        the prebuilt ones (needs about 2 GB of memory; the source
#                        code is downloaded if it is not here)
#   --prebuilt           go back to the prebuilt images after building from source
#   --image-tag TAG      prebuilt version to run: "latest" or a release such as v2.4.0
#
# Safe to re-run: existing secrets and certificates are kept, and the newest
# images for the chosen tag are downloaded.
set -euo pipefail
cd "$(dirname "$0")"

ROLE="" DOMAIN="" EMAIL="" TLS="" CERT="" KEY="" CLUSTER_HOST=""
MASTER="" TOKEN="" NAME="" ADVERTISE="" ENGINE_PORT="" INSECURE=false
FROM_SOURCE=false PREBUILT=false IMAGE_TAG_ARG="" HTTP_PORT_ARG="" HTTPS_PORT_ARG=""

usage() { sed -n '2,43p' "$0" | sed 's/^# \{0,1\}//'; }
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
    --http-port) need_value "$@"; HTTP_PORT_ARG="$2"; shift 2 ;;
    --https-port) need_value "$@"; HTTPS_PORT_ARG="$2"; shift 2 ;;
    --master) need_value "$@"; MASTER="$2"; shift 2 ;;
    --token) need_value "$@"; TOKEN="$2"; shift 2 ;;
    --name) need_value "$@"; NAME="$2"; shift 2 ;;
    --advertise) need_value "$@"; ADVERTISE="$2"; shift 2 ;;
    --engine-port) need_value "$@"; ENGINE_PORT="$2"; shift 2 ;;
    --insecure) INSECURE=true; shift ;;
    --build-from-source) FROM_SOURCE=true; shift ;;
    --prebuilt) PREBUILT=true; shift ;;
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
unset_env() { # unset_env KEY: remove the line from .env
  local tmp; tmp="$(mktemp)"
  grep -v "^$1=" .env > "$tmp" || true
  cat "$tmp" > .env && rm -f "$tmp"
}
# What get.sh recorded about where this installation came from.
version_info() { [ -f .version ] && sed -n "s/^$1=//p" .version | head -n1 || true; }
is_ip() { printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; }
# The address other machines use to reach this server: the one its default route leaves from.
server_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  fi
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "$ip"
}

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

# Records where images come from and which repository to watch for updates;
# called once .env exists.
configure_images() {
  ensure_env IMAGE_TAG latest
  [ -z "$IMAGE_TAG_ARG" ] || set_env IMAGE_TAG "$IMAGE_TAG_ARG"
  case "$(get_env IMAGE_PREFIX)" in ""|*OWNER/REPO*) set_env IMAGE_PREFIX "$(default_image_prefix)" ;; esac
  if $FROM_SOURCE; then set_env INSTALL_FROM source
  elif $PREBUILT; then set_env INSTALL_FROM images
  elif [ -z "$(get_env IMAGE_PREFIX)" ]; then set_env INSTALL_FROM source
  else ensure_env INSTALL_FROM images; fi
  # Built images need a name too.
  [ -n "$(get_env IMAGE_PREFIX)" ] || set_env IMAGE_PREFIX streamnode

  local repo; repo="$(version_info REPO)"
  if [ -z "$repo" ]; then
    case "$(get_env IMAGE_PREFIX)" in ghcr.io/*/*) repo="$(get_env IMAGE_PREFIX)"; repo="${repo#ghcr.io/}" ;; esac
  fi
  [ -z "$repo" ] || ensure_env UPDATE_REPO "$repo"
  ensure_env UPDATE_BRANCH "$(b="$(version_info BRANCH)"; echo "${b:-main}")"
}

# Makes sure the source code is here, downloading it if this server was
# installed without it.
ensure_source() {
  [ -d rust_src ] && [ -d admin_src ] && return 0
  local tarball; tarball="$(version_info TARBALL)"
  [ -n "$tarball" ] || fail "The source code is not on this server and its origin is unknown. Install with: get.sh --with-source"
  command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 || fail "curl and tar are needed to download the source code."
  echo "Downloading the source code..."
  local work; work="$(mktemp -d)"
  curl -fsSL -m 120 "$tarball" -o "$work/src.tar.gz" || { rm -rf "$work"; fail "Could not download the source code from $tarball"; }
  mkdir "$work/src" && tar -xzf "$work/src.tar.gz" -C "$work/src" --strip-components=1 || { rm -rf "$work"; fail "The source download is not a valid archive."; }
  rm -rf rust_src admin_src
  cp -R "$work/src/rust_src" "$work/src/admin_src" . && rm -rf "$work"
}

build_from_source() {
  ensure_source
  # Recorded so that plain "docker compose" commands include the build file from now on.
  set_env INSTALL_FROM source
  set_env COMPOSE_FILE docker-compose.yml:docker-compose.build.yml
  $COMPOSE -f docker-compose.yml -f docker-compose.build.yml up --build -d
}

# The updater: a directory the dashboard and the host share, and a scheduler
# entry that looks every few minutes for something to do (an update requested
# in the dashboard, the daily automatic update, or a master to keep up with).
setup_updater() {
  mkdir -p control
  # Written by the services too, which run as unprivileged users.
  chmod 777 control
  [ -x scripts/update.sh ] && [ -f .version ] || return 0
  if ./scripts/update.sh schedule install >/dev/null 2>&1; then
    UPDATER_NOTE="Updates: the dashboard shows when a new version is out and can install it, or do so automatically (Updates tab)."
    [ "$ROLE" != slave ] || UPDATER_NOTE="Updates: this server follows the version its master runs."
  else
    UPDATER_NOTE="Updates: cron is not installed here, so updates cannot run by themselves. Install cron and run: ./scripts/update.sh schedule install"
  fi
}

# Downloads the prebuilt images and starts the services; compiles from source
# when asked to, or when the images cannot be downloaded.
start_services() {
  if [ "$(get_env INSTALL_FROM)" = source ]; then
    echo "Building the images from source (several minutes; needs about 2 GB of memory)..."
    build_from_source
    return
  fi
  [ "$(get_env COMPOSE_FILE)" != docker-compose.yml:docker-compose.build.yml ] || unset_env COMPOSE_FILE
  echo "Downloading the images ($(get_env IMAGE_PREFIX), tag $(get_env IMAGE_TAG))..."
  local problem
  if problem="$($COMPOSE pull --quiet 2>&1)"; then
    $COMPOSE up -d --remove-orphans
    # The source code is not needed to run prebuilt images.
    if [ -x scripts/migrate.sh ]; then ./scripts/migrate.sh slim; fi
  else
    echo "The prebuilt images could not be downloaded:"
    printf '%s\n' "$problem" | tail -n 2 | sed 's/^/  /'
    echo "Building from source instead (several minutes; needs about 2 GB of memory)."
    echo "For a private registry, sign in first (docker login ghcr.io) and run this again with --prebuilt."
    build_from_source
  fi
}

# ── Requirements ───────────────────────────────────────────────────────────

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. See https://docs.docker.com/engine/install/"
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else fail "Docker Compose is not installed."; fi
docker info >/dev/null 2>&1 || fail "Cannot talk to the Docker daemon. Run this script as root or as a member of the docker group."

# ── Role ───────────────────────────────────────────────────────────────────

# Bring an installation made by an older version up to date first.
if [ -x scripts/migrate.sh ]; then ./scripts/migrate.sh prepare; fi

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
  setup_updater
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

${UPDATER_NOTE:-}
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
      echo "A domain name is optional. Without one the gateway is reached by this server's"
      echo "IP address over plain HTTP; a domain can be added later by running this again."
      read -r -p "Domain name (e.g. stream.example.com), or leave empty to use the IP address: " DOMAIN
    fi
    if [ -z "$DOMAIN" ]; then
      DOMAIN="$(server_ip)"
      [ -n "$DOMAIN" ] || fail "Could not work out this server's IP address. Pass it: --domain 192.168.1.20"
      echo "No domain given: using this server's address, $DOMAIN."
    fi
    ( umask 077; cp .env.example .env )
    set_env ROLE "$ROLE"
    set_env DOMAIN "$DOMAIN"
    set_env POSTGRES_PASSWORD "$(random 24)"
    set_env REDIS_PASSWORD "$(random 24)"
    set_env ENGINE_SECRET "$(random 24)"
    set_env ADMIN_PASSWORD "$(random 12)"
    set_env ADMIN_API_KEY "rgw_$(random 24)"
    [ -z "$EMAIL" ] || set_env LETSENCRYPT_EMAIL "$EMAIL"
    echo "Created .env with generated secrets."
  else
    [ -z "$DOMAIN" ] || set_env DOMAIN "$DOMAIN"
    [ -z "$EMAIL" ] || set_env LETSENCRYPT_EMAIL "$EMAIL"
    echo "Using existing .env."
  fi
  DOMAIN="$(get_env DOMAIN)"
  # Reached by IP address: URLs follow whichever address a request arrives on
  # (local or public), nothing is redirected to HTTPS, and there is no name to
  # get a certificate for. With a domain, that name is the public address.
  local by_ip=false
  if is_ip "$DOMAIN"; then
    by_ip=true
    set_env PUBLIC_BASE_URL ""
    set_env FORCE_HTTPS false
    case "$TLS" in
      letsencrypt) fail "Let's Encrypt needs a domain name. Pass --domain stream.example.com, or leave out --tls." ;;
      "") [ -n "$CERT" ] || [ -n "$(get_env TLS_MODE)" ] || TLS=selfsigned ;;
    esac
  else
    set_env PUBLIC_BASE_URL "https://$DOMAIN"
    set_env FORCE_HTTPS true
    # Coming from an address-only install, the certificate question is open again.
    if [ -z "$TLS" ] && [ -z "$CERT" ] && [ "$(get_env TLS_MODE)" = selfsigned ] && [ -t 0 ]; then set_env TLS_MODE ""; fi
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
  for pair in "HTTP_PORT:$HTTP_PORT_ARG" "HTTPS_PORT:$HTTPS_PORT_ARG"; do
    [ -n "${pair#*:}" ] || continue
    case "${pair#*:}" in *[!0-9]*) fail "Ports must be numbers." ;; esac
    set_env "${pair%%:*}" "${pair#*:}"
  done

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
  local previous_tls; previous_tls="$(get_env TLS_MODE)"
  [ -n "$TLS" ] || TLS="$previous_tls"
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
  self_signed() { # self_signed FILE: a certificate for $DOMAIN, chain followed by key
    local tmp; tmp="$(mktemp -d)"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=$(is_ip "$DOMAIN" && echo IP || echo DNS):$DOMAIN" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1
    ( umask 077; cat "$tmp/cert.pem" "$tmp/key.pem" > "$1" )
    rm -rf "$tmp"
  }
  # The gateway always answers on every network interface.
  set_env HTTP_BIND 0.0.0.0
  if [ "$TLS" = external ]; then
    # HTTPS is handled in front of this server: no HTTPS listener here and no
    # certificate for the domain. The unused HTTPS port is kept off the network.
    set_env HTTPS_BIND 127.0.0.1
    [ "$(get_env HTTPS_PORT)" != 443 ] || set_env HTTPS_PORT 8443
    # Only the encrypted Redis link to slave nodes needs a certificate, and only
    # on a server that takes slave nodes: an internal one, never shown to listeners.
    if [ "$ROLE" = master ] || [ -n "$(get_env CLUSTER_HOST)" ]; then
      set_env CLUSTER_BIND 0.0.0.0
      [ -s certs/cluster.pem ] || { self_signed certs/cluster.pem; echo "Created an internal certificate for the link to slave nodes (certs/cluster.pem)."; }
      set_env CLUSTER_CERT /etc/haproxy/certs/cluster.pem
    else
      set_env CLUSTER_CERT ""
    fi
  else
    set_env HTTPS_BIND 0.0.0.0
    set_env CLUSTER_CERT /etc/haproxy/certs/stream.pem
    # HAProxy's HTTPS listener needs a certificate to start: a self-signed one
    # stands in until Let's Encrypt has issued, or when none was asked for.
    # Going back to self-signed from Let's Encrypt replaces its certificate,
    # which would otherwise expire unrenewed.
    if [ ! -s certs/stream.pem ] || { [ "$TLS" = selfsigned ] && [ "$previous_tls" = letsencrypt ]; }; then
      echo "Generating a self-signed certificate for $DOMAIN."
      self_signed certs/stream.pem
    fi
  fi

  configure_images
  setup_updater
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

  # Let's Encrypt: obtained now, and the scheduler renews it (or keeps trying
  # every hour if it cannot be issued yet, e.g. while DNS is spreading).
  local le_issued=true le_scheduled=true
  if [ "$TLS" = letsencrypt ]; then
    echo
    ./scripts/letsencrypt.sh issue || le_issued=false
    ./scripts/letsencrypt.sh schedule install || le_scheduled=false
  elif command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "# streamnode certificate ($(pwd))"; then
    ./scripts/letsencrypt.sh schedule remove >/dev/null
  fi

  echo
  echo "The gateway is running ($ROLE)."
  local port_suffix=""
  [ "$(get_env HTTP_PORT)" = 80 ] || port_suffix=":$(get_env HTTP_PORT)"
  if $by_ip; then
    echo "  Dashboard:  http://$DOMAIN$port_suffix/admin/"
    echo "  API docs:   http://$DOMAIN$port_suffix/api/v1/docs"
    echo "  Streams:    http://$DOMAIN$port_suffix/<station-slug>"
  else
    echo "  Dashboard:  https://$DOMAIN/admin/"
    echo "  API docs:   https://$DOMAIN/api/v1/docs"
    echo "  Streams:    http(s)://$DOMAIN/<station-slug>"
    echo "  By address: http://$(server_ip)$port_suffix/admin/  (same service, from the local network)"
  fi
  echo "  Sign in as: $(get_env ADMIN_USERNAME)"
  if $created; then
    echo "  Password:   $(get_env ADMIN_PASSWORD)"
    echo "  API key:    $(get_env ADMIN_API_KEY)"
    echo "These were generated just now and are stored in .env. Keep that file private."
  else
    echo "  Password and API key are in .env."
  fi
  case "$TLS" in
    letsencrypt)
      if ! $le_issued; then
        echo
        echo "Let's Encrypt did not issue a certificate yet (the reason is shown above), so HTTPS is"
        echo "using a temporary self-signed one for now. Most often $DOMAIN does not point at this"
        echo "server yet, or TCP port 80 is closed in a firewall or cloud security group."
        if $le_scheduled; then
          echo "Once that is fixed, nothing else is needed: the server tries again every hour. To try"
          echo "at once: ./scripts/letsencrypt.sh issue (or Updates > HTTPS certificate in the dashboard)."
        else
          echo "Once that is fixed, run: ./scripts/letsencrypt.sh issue"
        fi
      fi
      if ! $le_scheduled; then
        echo
        echo "Renewal is NOT automatic: cron is not installed, and Let's Encrypt certificates last 90 days."
        echo "Install cron, then run: ./scripts/letsencrypt.sh schedule install"
      fi ;;
    external)
      echo
      echo "HTTPS is handled in front of this server: no certificate was set up here and there"
      echo "is no HTTPS listener. Point your load balancer or proxy at this server's port"
      echo "$(get_env HTTP_PORT) over plain HTTP. It must add X-Forwarded-For, must not buffer responses, and"
      echo "must allow long-lived connections."
      echo "  From the local network: http://$(server_ip)$port_suffix/admin/"
      if [ -z "$(get_env CLUSTER_HOST)" ]; then
        echo "To take slave nodes later, run: ./install.sh --cluster-host <address that reaches this server directly>"
      fi ;;
    selfsigned)
      echo
      if $by_ip; then
        echo "No domain is set, so the gateway is served over plain HTTP on this address. Anything"
        echo "sent to it, including the dashboard password, is not encrypted: fine on a trusted"
        echo "network, not on the open internet. To add a domain and HTTPS later, run:"
        echo "  ./install.sh --domain stream.example.com --tls letsencrypt --email you@example.com"
      else
        echo "This server uses a temporary self-signed certificate. For a real one, re-run with"
        echo "--tls letsencrypt --email you@example.com, or --tls provided --cert FILE --key FILE."
      fi ;;
  esac
  [ -z "${UPDATER_NOTE:-}" ] || { echo; echo "$UPDATER_NOTE"; }
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
