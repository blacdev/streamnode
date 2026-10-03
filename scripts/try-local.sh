#!/usr/bin/env bash
# Runs the whole gateway on this machine for a hands-on test: a master with
# its own engine, a demo radio station to relay, and a slave node that joins
# the master with a token just as a second server would.
# Nothing here touches a real installation: it uses its own project name,
# its own settings file (.env.local) and its own data volumes.
#
#   scripts/try-local.sh              build, start and set up the demo
#   scripts/try-local.sh status       show services and live numbers
#   scripts/try-local.sh logs [name]  follow logs (optionally one service)
#   scripts/try-local.sh primary-down    switch the demo station's primary stream off (watch failover)
#   scripts/try-local.sh primary-silent  keep it connected but sending silence
#   scripts/try-local.sh primary-up      bring it back (watch the station return to it)
#   scripts/try-local.sh backup-down | backup-silent | backup-up    the same for the backup stream
#   scripts/try-local.sh loadtest     hit HTTPS and the stream with bursts of requests and report
#   scripts/try-local.sh stop         stop everything, keep the data
#   scripts/try-local.sh reset        stop everything and delete the test data
#
# Ports: 8080 (http), 8443 (https) and 8090 (the demo edge server); 6390 and
# 8454 are bound to localhost only. To use others:
#   HTTP_PORT=9080 HTTPS_PORT=9443 EDGE_HTTP_PORT=9090 scripts/try-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.local
PROJECT=radio-gateway-local

fail() { echo "Error: $*" >&2; exit 1; }

case "${1:-}" in
  -h|--help|help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. See https://docs.docker.com/engine/install/"
command -v curl >/dev/null 2>&1 || fail "curl is not installed."

# Use sudo only if this user cannot reach the Docker daemon directly.
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    echo "Docker needs elevated rights for this user; using sudo."
    DOCKER=(sudo docker)
    "${DOCKER[@]}" info >/dev/null 2>&1 || fail "Cannot reach the Docker daemon, even with sudo. Is Docker running? (sudo systemctl start docker)"
  else
    fail "Cannot reach the Docker daemon. Start Docker, or add your user to the docker group."
  fi
fi
"${DOCKER[@]}" compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is not installed."

compose() {
  "${DOCKER[@]}" compose -p "$PROJECT" --env-file "$ENV_FILE" --profile master --profile local-engine \
    -f docker-compose.yml -f docker-compose.build.yml -f docker-compose.demo.yml "$@"
}
get_env() { grep "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true; }

write_env() {
  local http="${HTTP_PORT:-8080}" https="${HTTPS_PORT:-8443}"
  ( umask 077; cat > "$ENV_FILE" <<EOF
# Local test settings, written by scripts/try-local.sh. Safe to delete.
ROLE=both
COMPOSE_PROFILES=master,local-engine
LOCAL_ENGINE=audio_engine:3000
DOMAIN=localhost
PUBLIC_BASE_URL=http://localhost:$http
HTTP_PORT=$http
HTTPS_PORT=$https
EDGE_HTTP_PORT=${EDGE_HTTP_PORT:-8090}
FORCE_HTTPS=false
POSTGRES_USER=gateway
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=gateway_management
REDIS_PASSWORD=$(openssl rand -hex 16)
ENGINE_SECRET=$(openssl rand -hex 16)
CLUSTER_BIND=127.0.0.1
CLUSTER_PORT=${CLUSTER_PORT:-6390}
RELAY_BIND=127.0.0.1
RELAY_PORT=${RELAY_PORT:-8454}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=local-test-password
ADMIN_API_KEY=rgw_$(openssl rand -hex 24)
CORS_ORIGINS=*
ALLOW_PRIVATE_SOURCES=true
DEFAULT_MAX_STATIONS=5
IDLE_GRACE_SECS=10
STALL_TIMEOUT_SECS=5
PRIMARY_RETRY_SECS=10
METADATA_POLL_SECS=5
BURST_BYTES=65536
STATS_MINUTE_RETENTION_DAYS=90
EOF
  )
}

require_env() { [ -f "$ENV_FILE" ] || fail "The local test is not set up yet. Run scripts/try-local.sh first."; }

api() { # api METHOD PATH [JSON]
  local method="$1" path="$2" body="${3:-}"
  curl -sS -X "$method" "$BASE/api/v1$path" -H "X-API-Key: $KEY" \
    ${body:+-H "Content-Type: application/json" -d "$body"}
}

# Runs a command inside the demo source container (it is not published on the host).
demo_control() { # demo_control primary|backup up|down|silent
  compose exec -T demo_source wget -q -O - "http://127.0.0.1:8000/control?$1=$2"
  echo
}

start() {
  command -v openssl >/dev/null 2>&1 || fail "openssl is not installed."
  if [ ! -f "$ENV_FILE" ]; then
    write_env
    echo "Wrote $ENV_FILE."
  fi
  BASE="http://localhost:$(get_env HTTP_PORT)"
  EDGE_PORT="$(get_env EDGE_HTTP_PORT)"
  EDGE="http://localhost:${EDGE_PORT:-8090}"
  KEY="$(get_env ADMIN_API_KEY)"

  mkdir -p certs
  if [ ! -s certs/stream.pem ]; then
    tmp="$(mktemp -d)"
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1
    ( umask 077; cat "$tmp/cert.pem" "$tmp/key.pem" > certs/stream.pem )
    rm -rf "$tmp"
    echo "Created a self-signed certificate for localhost."
  fi

  grep -q '^ENGINE_SECRET=' "$ENV_FILE" || fail "$ENV_FILE was written by an older version. Run: scripts/try-local.sh reset"

  echo "Building and starting (the first build compiles the engine and takes several minutes)..."
  compose up --build -d

  echo -n "Waiting for the gateway"
  ready=false
  for _ in $(seq 1 90); do
    if curl -fsS "$BASE/api/v1/health" >/dev/null 2>&1; then ready=true; break; fi
    echo -n "."; sleep 2
  done
  echo
  $ready || { compose ps; fail "The gateway did not become healthy. Look at: scripts/try-local.sh logs"; }

  # Demo content. Every call is safe to repeat, so re-running this script is fine.
  api PUT /stations/demo '{
    "name": "Demo Station",
    "primary_url": "http://demo_source:8000/primary",
    "backup_url": "http://demo_source:8000/backup",
    "metadata_url": "http://demo_source:8000/nowplaying.json"
  }' >/dev/null
  api PUT /stations/demo-limited '{
    "name": "Demo Station (max 2 listeners)",
    "primary_url": "http://demo_source:8000/primary",
    "max_listeners": 2
  }' >/dev/null
  # The demo slave joins the way a real second server does: with a one-time
  # token from the master. Once joined it keeps its enrolment in a volume.
  if ! api GET /servers | grep -q '"name":"edge-2"'; then
    token="$(api POST /cluster/join-tokens '{"note": "demo slave"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    [ -n "$token" ] || fail "Could not create a join token for the demo slave."
    DEMO_JOIN_TOKEN="$token" compose up -d demo_slave >/dev/null
    echo -n "Waiting for the demo slave to join"
    for _ in $(seq 1 30); do
      if api GET /servers | grep -q '"name":"edge-2"'; then break; fi
      echo -n "."; sleep 2
    done
    echo
    api GET /servers | grep -q '"name":"edge-2"' || echo "The demo slave has not joined yet; see: scripts/try-local.sh logs demo_slave"
  fi
  if ! api GET /servers | grep -q '"name":"edge-3"'; then
    api POST /servers '{"name": "edge-3", "host": "localhost", "mode": "direct"}' >/dev/null
  fi
  # Sample files for trying idents and fallback audio.
  rm -rf demo-samples
  compose cp demo_source:/app/samples ./demo-samples >/dev/null 2>&1 || echo "Could not copy the sample audio files out of the demo source."

  cat <<EOF

The gateway is running locally.

  Dashboard     $BASE/admin/
                sign in as: admin / $(get_env ADMIN_PASSWORD)
  API docs      $BASE/api/v1/docs
  API key       $KEY

  Demo stream   $BASE/demo            (open in a browser, VLC, or: mpv $BASE/demo)
  Playlist      $BASE/demo.m3u
  Now playing   $BASE/api/v1/public/stations/demo/now-playing

Things to try:

  1. Play the demo stream, then watch "Listeners" change on the dashboard.
  2. Failover: while it plays, run   scripts/try-local.sh primary-down
     After 6 seconds (the station's failover delay) the tone changes (backup
     stream) and the station shows "On air (backup)".
     Run   scripts/try-local.sh primary-up   and it returns within about 3 seconds,
     fading out the backup and fading the primary in.
     Silence counts too:   scripts/try-local.sh primary-silent
  2b. Ident and fallback audio: on the dashboard, Stations > Demo Station > Edit.
     Under Ident upload   demo-samples/ident.mp3   and under Fallback audio
     upload   demo-samples/fallback.mp3   then save. Play the stream and run:
       scripts/try-local.sh primary-down    -> 6 s, the ident, then the backup
       scripts/try-local.sh backup-down     -> 6 s, the ident, then the fallback file
                                               ("On air (fallback audio)")
       scripts/try-local.sh primary-up      -> within about 3 s: the ident, then the live stream
     The demo-samples/refused-*.* files are each turned down, with the reason.
     Storage quotas: Accounts > Storage, and Settings.
  3. Load spreading: open the stream in several players and look at the
     Servers tab. Listeners are shared between "local" (the engine beside the
     master) and "edge-2" (the slave node), and the tab shows each server's
     CPU, memory and disk. Try Drain and Weight.
  4. Adding a server: Servers > Add server shows the one-line command a new
     slave node would run to join this master.
     (Optional extra: $EDGE/demo is an edge server, "edge-3", with its own
     HAProxy; see docs/SCALING.md.)
  5. Listener limit: $BASE/demo-limited accepts two listeners; the third gets 503.
  6. Add your own station on the dashboard using a real stream URL.
  7. The API:
       curl -H "X-API-Key: $KEY" $BASE/api/v1/stations
       curl -H "X-API-Key: $KEY" $BASE/api/v1/stations/demo/status

History charts fill in after a minute or two of listening.
Stop with:  scripts/try-local.sh stop      Remove test data with:  scripts/try-local.sh reset
EOF
}

status() {
  require_env
  BASE="http://localhost:$(get_env HTTP_PORT)"
  KEY="$(get_env ADMIN_API_KEY)"
  compose ps
  echo
  echo "Overview:  $(api GET /overview)"
  echo "Demo:      $(api GET /stations/demo/status)"
  echo "Servers:   $(api GET /servers)"
}

# A quick resilience check: bursts of parallel HTTPS requests, a burst that
# exceeds the API rate limit, and 20 simultaneous listeners.
loadtest() {
  require_env
  local http="http://localhost:$(get_env HTTP_PORT)" https="https://localhost:$(get_env HTTPS_PORT)"
  count() { sort | uniq -c | awk '{printf "%s x HTTP %s   ", $1, $2}'; echo; }
  echo "1. 3 x 400 parallel HTTPS requests to a stream path (expect all 404, none 000):"
  for _ in 1 2 3; do
    seq 1 400 | xargs -P 40 -I{} curl -sk -o /dev/null -w '%{http_code}\n' "$https/no-such-station" | count
  done
  echo "2. 600 parallel API requests (expect about 300 x 200, the rest 429 from the rate limit):"
  seq 1 600 | xargs -P 40 -I{} curl -sk -o /dev/null -w '%{http_code}\n' "$https/api/v1/health" | count
  echo "3. 20 listeners on the demo station for 8 seconds:"
  for _ in $(seq 1 20); do curl -s -m 8 -o /dev/null "$http/demo" & done
  sleep 5
  KEY="$(get_env ADMIN_API_KEY)"; BASE="$http"
  echo "   waiting for the rate limit window to pass..."; sleep 6
  echo "   servers: $(api GET /servers | grep -o '"name":"[^"]*"\|"connections":[0-9]*' | paste -sd' ')"
  wait
  echo "4. Services after the test:"
  compose ps --format 'table {{.Service}}\t{{.Status}}'
}

case "${1:-start}" in
  start|up) start ;;
  loadtest) loadtest ;;
  status) status ;;
  logs) require_env; shift; compose logs -f --tail 100 "$@" ;;
  primary-down|primary-up|primary-silent|backup-down|backup-up|backup-silent)
    require_env; demo_control "${1%%-*}" "${1##*-}" ;;
  stop|down) require_env; compose down ;;
  reset) require_env; compose down -v --remove-orphans; rm -rf "$ENV_FILE" demo-samples; echo "Test data removed." ;;
  *) fail "Unknown command: $1 (try: scripts/try-local.sh help)" ;;
esac
