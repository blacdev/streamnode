#!/usr/bin/env bash
# Run on the MASTER. Prints the command that installs a new slave node and
# joins it to this master. The command contains a one-time join token.
#
#   scripts/add-server.sh                 token valid for 60 minutes, one server
#   scripts/add-server.sh --minutes 240   longer validity
#   scripts/add-server.sh --uses 3        one token for three servers
set -euo pipefail
cd "$(dirname "$0")/.."

MINUTES=60 USES=1
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes) MINUTES="$2"; shift 2 ;;
    --uses) USES="$2"; shift 2 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

get_env() { grep "^$1=" .env | head -n1 | cut -d= -f2- || true; }
[ -f .env ] || { echo "No .env here: run this on the master, in the gateway's directory." >&2; exit 1; }
case "$(get_env ROLE)" in master|both) ;; *) echo "This server is not a master." >&2; exit 1 ;; esac
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi

# Asked from inside the admin container, so it works whatever the certificate or DNS state.
answer="$($COMPOSE exec -T admin_dashboard wget -q -O - \
  --header "X-API-Key: $(get_env ADMIN_API_KEY)" --header "Content-Type: application/json" \
  --post-data "{\"note\": \"scripts/add-server.sh\", \"expires_minutes\": $MINUTES, \"max_uses\": $USES}" \
  http://127.0.0.1:8000/api/v1/cluster/join-tokens)" || { echo "Could not create a join token. Is the gateway running? ($COMPOSE ps)" >&2; exit 1; }
token="$(printf '%s' "$answer" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$token" ] || { echo "Unexpected answer from the API: $answer" >&2; exit 1; }

# The address slave nodes reach this master on: its public address if it has
# one, otherwise its IP address and HTTP port.
master="$(get_env PUBLIC_BASE_URL)"
if [ -z "$master" ]; then
  master="http://$(get_env DOMAIN)"
  [ "$(get_env HTTP_PORT)" = 80 ] || master="$master:$(get_env HTTP_PORT)"
fi
# A master the slave cannot verify (plain HTTP, or still on its self-signed
# certificate) needs --insecure on the slave.
options="--role slave --master $master --token $token"
case "$(get_env TLS_MODE)" in selfsigned|"") options="$options --insecure" ;; esac
case "$master" in http://*) case "$options" in *--insecure*) ;; *) options="$options --insecure" ;; esac ;; esac

# The command for a new, empty server: it fetches the bootstrap script from the
# repository this master was installed from.
repo="$(sed -n 's/^REPO=//p' .version 2>/dev/null | head -n1)"; [ -n "$repo" ] || repo="$(get_env UPDATE_REPO)"
branch="$(sed -n 's/^BRANCH=//p' .version 2>/dev/null | head -n1)"; [ -n "$branch" ] || branch="$(get_env UPDATE_BRANCH)"
if [ -n "$repo" ]; then
  command="curl -fsSL https://raw.githubusercontent.com/$repo/${branch:-main}/get.sh | bash -s -- $options"
  echo "On the new server (nothing needs to be installed on it first), run:"
else
  command="./install.sh $options"
  echo "On the new server, in a copy of this project, run:"
fi
echo
echo "  $command"
echo
echo "The token works for $USES server(s) and expires in $MINUTES minutes."
if [ "$(get_env CLUSTER_BIND)" = "127.0.0.1" ]; then
  echo
  echo "Before that, let slave nodes reach this server: set CLUSTER_BIND=0.0.0.0 in .env,"
  echo "run '$COMPOSE up -d', and open TCP port $(get_env CLUSTER_PORT) to them in the firewall."
fi
case "$(get_env TLS_MODE)" in
  selfsigned|"")
    echo
    echo "This master has no trusted certificate, so the command includes --insecure: the"
    echo "new server will not verify it. Fine for testing; for production give the master a"
    echo "real certificate first (see docs/INSTALLATION.md) and create the command again." ;;
  external)
    if [ -z "$(get_env CLUSTER_HOST)" ] || [ -z "$(get_env CLUSTER_CERT)" ]; then
      echo
      echo "HTTPS for this domain is handled in front of this server, so slave nodes need an"
      echo "address that reaches it directly. First run:"
      echo "  ./install.sh --cluster-host <address of this server>"
    fi ;;
esac
