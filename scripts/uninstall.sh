#!/usr/bin/env bash
# Removes a gateway installation from this server, of any version and any role,
# so it can be installed again from scratch.
#
#   scripts/uninstall.sh                 stop and remove the services AND their data
#   scripts/uninstall.sh --keep-data     remove the services, keep stations, accounts and statistics
#   scripts/uninstall.sh --remove-code   also delete the code directory (settings and certificates included)
#   scripts/uninstall.sh --remove-images also delete the downloaded or built images
#   scripts/uninstall.sh --yes           do not ask for confirmation
#   scripts/uninstall.sh --dir PATH      the installation to remove (default: where this script lives,
#                                        or /opt/radio-gateway when it is piped from curl)
#
# It also works without the code present:
#   curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/scripts/uninstall.sh | bash -s -- --yes
#
# Take a backup first if anything is worth keeping: scripts/backup.sh
set -euo pipefail

KEEP_DATA=false REMOVE_CODE=false REMOVE_IMAGES=false ASSUME_YES=false DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-data) KEEP_DATA=true; shift ;;
    --remove-code) REMOVE_CODE=true; shift ;;
    --remove-images) REMOVE_IMAGES=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

fail() { echo "Error: $*" >&2; exit 1; }

if [ -z "$DIR" ]; then
  # Run from a checkout, the installation is the directory above scripts/.
  # Piped from curl there is no script file, so the default location is used.
  if [ -f "${BASH_SOURCE[0]:-}" ]; then DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; else DIR=/opt/radio-gateway; fi
fi

command -v docker >/dev/null 2>&1 || fail "Docker is not installed, so there are no gateway services on this server."
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then DOCKER=(sudo docker)
  else fail "Cannot talk to the Docker daemon. Run this as root or as a member of the docker group."; fi
fi
SUDO=""; [ "${DOCKER[0]}" = sudo ] && SUDO=sudo

# Everything the gateway creates carries its Compose project name, whichever
# version or role installed it. The local test and edge variants are separate
# projects and are removed too.
PROJECTS="radio-gateway radio-gateway-edge radio-gateway-local"
list() { # list containers|volumes|networks
  local kind="$1" project
  for project in $PROJECTS; do
    case "$kind" in
      containers) "${DOCKER[@]}" ps -aq --filter "label=com.docker.compose.project=$project" ;;
      volumes) "${DOCKER[@]}" volume ls -q --filter "label=com.docker.compose.project=$project" ;;
      networks) "${DOCKER[@]}" network ls -q --filter "label=com.docker.compose.project=$project" ;;
    esac
  done
}

containers="$(list containers)"; volumes="$(list volumes)"; networks="$(list networks)"
count() { printf '%s' "$1" | grep -c . || true; }

echo "Gateway installation on this server:"
echo "  services (containers): $(count "$containers")"
echo "  data volumes:          $(count "$volumes")$($KEEP_DATA && echo '  (kept)')"
echo "  code and settings:     $([ -d "$DIR" ] && echo "$DIR" || echo 'not found')$($REMOVE_CODE || echo '  (kept)')"
if [ -z "$containers$volumes$networks" ] && { ! $REMOVE_CODE || [ ! -d "$DIR" ]; }; then
  echo "Nothing to remove."
  exit 0
fi

if ! $ASSUME_YES; then
  $KEEP_DATA || echo "This permanently deletes every station, account, API key and statistic stored on this server."
  if [ -t 0 ]; then tty=/dev/stdin; elif (exec < /dev/tty) 2>/dev/null; then tty=/dev/tty; else fail "No terminal to confirm on. Add --yes to proceed."; fi
  printf "Type 'remove' to continue: " > /dev/tty 2>/dev/null || printf "Type 'remove' to continue: "
  read -r answer < "$tty"
  [ "$answer" = remove ] || { echo "Cancelled."; exit 1; }
fi

if [ -n "$containers" ]; then
  echo "Stopping and removing the services..."
  # shellcheck disable=SC2086
  "${DOCKER[@]}" rm -f $containers >/dev/null
fi
if [ -n "$networks" ]; then
  # shellcheck disable=SC2086
  "${DOCKER[@]}" network rm $networks >/dev/null 2>&1 || true
fi
if ! $KEEP_DATA && [ -n "$volumes" ]; then
  echo "Deleting the data volumes..."
  # shellcheck disable=SC2086
  "${DOCKER[@]}" volume rm $volumes >/dev/null
fi

if $REMOVE_IMAGES; then
  echo "Deleting the gateway images..."
  # Only the gateway's own images: those named in this installation's settings,
  # and ones built locally under the default name. Nothing else is touched.
  prefix="$(grep '^IMAGE_PREFIX=' "$DIR/.env" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  images="$("${DOCKER[@]}" images --format '{{.Repository}}:{{.Tag}}' | awk -v prefix="$prefix" '
    { repo = $0; sub(/:[^:\/]*$/, "", repo) }
    repo ~ /^radio-gateway(-[a-z]+)?[\/-]/ { print; next }
    prefix != "" && (repo == prefix "/engine" || repo == prefix "/admin") { print }' || true)"
  # shellcheck disable=SC2086
  [ -z "$images" ] || "${DOCKER[@]}" rmi $images >/dev/null 2>&1 || true
fi

if $REMOVE_CODE && [ -d "$DIR" ]; then
  # Refuse anything that is not recognisably a gateway directory.
  [ -f "$DIR/install.sh" ] && [ -f "$DIR/haproxy.cfg" ] || fail "$DIR does not look like a gateway installation; not deleting it."
  echo "Deleting $DIR..."
  cd /
  $SUDO rm -rf "$DIR"
elif [ -d "$DIR" ]; then
  # A fresh install must not reuse the old role, passwords or certificate.
  if ! $KEEP_DATA; then
    $SUDO rm -f "$DIR/.env" "$DIR/.env.local" "$DIR/certs/stream.pem" "$DIR/edge/.env" "$DIR/edge/certs/stream.pem"
    echo "Removed the old settings and certificate from $DIR."
  fi
fi

echo
echo "The gateway has been removed from this server."
$KEEP_DATA && echo "Its data volumes were kept; a new install with the same settings (.env) will use them."
exit 0
