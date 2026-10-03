#!/usr/bin/env bash
# Watches the gateway's repository for a newer version and installs it.
#
# Normally nobody runs this by hand: the installer schedules "tick" every few
# minutes, and the dashboard (Updates) decides what it does: whether updates
# are installed automatically, at what time of day, and "install now".
#
#   scripts/update.sh                 check, and install the update if there is one (asks first)
#   scripts/update.sh check           only report; exit code 0 = up to date, 10 = update available
#   scripts/update.sh apply --yes     install the latest version without asking
#   scripts/update.sh apply --sha COMMIT   install a specific version (also the way to go back)
#   scripts/update.sh auto on [--time HH:MM]   same as switching automatic updates on in the dashboard
#   scripts/update.sh auto off
#   scripts/update.sh auto status
#   scripts/update.sh schedule install|remove   add or remove the scheduler entry (cron)
#   scripts/update.sh tick            what the scheduler runs
#
# Options: --no-backup   skip the database backup taken before updating (master)
#
# Updating downloads the new images and files, then restarts only the services
# that changed. Restarting an engine or the proxy disconnects its listeners for
# a few seconds; their players reconnect. Settings and data are kept.
# A slave node follows the version its master runs.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"

ACTION="${1:-run}"; [ $# -gt 0 ] && shift
SUB="" YES=false BACKUP=true TARGET="" AT="" GET_SH="${STREAMNODE_GET_SH:-${RADIO_GATEWAY_GET_SH:-}}"
while [ $# -gt 0 ]; do
  case "$1" in
    on|off|status|install|remove) SUB="$1"; shift ;;
    --yes|-y) YES=true; shift ;;
    --no-backup) BACKUP=false; shift ;;
    --sha) TARGET="${2:?--sha needs a value}"; shift 2 ;;
    --time) AT="${2:?--time needs a value}"; shift 2 ;;
    *) echo "Unknown option: $1 (see: scripts/update.sh help)" >&2; exit 1 ;;
  esac
done

fail() { echo "Error: $*" >&2; exit 1; }
info() { sed -n "s/^$1=//p" .version 2>/dev/null | head -n1; }
get_env() { grep "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- || true; }

# The control directory is shared with the services: the dashboard writes the
# settings there, this script writes what happened.
CONTROL="$DIR/control"
SETTINGS="$CONTROL/update-settings"
STATUS="$CONTROL/update-status"
read_kv() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -n1 || true; } # read_kv FILE KEY
write_kv() { # write_kv FILE KEY VALUE: replace one line, atomically
  local tmp; tmp="$(mktemp "$CONTROL/.tmp.XXXXXX")"
  { [ -f "$1" ] && grep -v "^$2=" "$1" || true; printf '%s=%s\n' "$2" "$3"; } > "$tmp"
  chmod 666 "$tmp" 2>/dev/null || true
  mv "$tmp" "$1"
}
ensure_control() {
  mkdir -p "$CONTROL"
  # Written by the services too, which run as unprivileged users.
  chmod 777 "$CONTROL" 2>/dev/null || true
  [ -f "$SETTINGS" ] || { printf 'AUTO=false\nTIME=04:15\nREQUEST=0\n' > "$SETTINGS"; chmod 666 "$SETTINGS" 2>/dev/null || true; }
}
report() { # report STATE MESSAGE
  write_kv "$STATUS" STATE "$1"
  write_kv "$STATUS" MESSAGE "$2"
  write_kv "$STATUS" UPDATED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

if [ "$ACTION" = help ] || [ "$ACTION" = -h ] || [ "$ACTION" = --help ]; then
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0
fi

# An installation from before versions were recorded is brought up to date first.
if [ ! -f .version ] && [ -x scripts/migrate.sh ]; then ./scripts/migrate.sh prepare; fi
[ -f .version ] || fail "This installation's version is not recorded. Run the one-line install command again in this directory; it keeps settings and data."
REPO="$(info REPO)"; BRANCH="$(info BRANCH)"; INSTALLED="$(info SHA)"
[ -n "$REPO" ] || fail ".version does not name a repository."
MARK="# streamnode updater ($DIR)"
TARBALL_OVERRIDE="${STREAMNODE_TARBALL:-${RADIO_GATEWAY_TARBALL:-}}"

latest_sha() {
  local sha
  sha="$(curl -fsSL -m 20 -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/${BRANCH:-main}" 2>/dev/null)" \
    || fail "Could not reach GitHub to look up the latest version of $REPO."
  case "$sha" in *[!0-9a-f]*|"") fail "Unexpected answer from GitHub." ;; esac
  printf '%s' "$sha"
}

# CI publishes images a few minutes after a change lands. Until the images for
# that exact commit exist, installing it would pair new files with old images.
images_ready() { # images_ready SHA
  [ "$(get_env INSTALL_FROM)" = source ] && return 0
  local prefix; prefix="$(get_env IMAGE_PREFIX)"
  case "$prefix" in ghcr.io/*) ;; *) return 0 ;; esac
  local path="${prefix#ghcr.io/}" image token code
  for image in engine admin; do
    token="$(curl -fsS -m 20 "https://ghcr.io/token?scope=repository:$path/$image:pull" 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" \
      -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
      "https://ghcr.io/v2/$path/$image/manifests/sha-${1:0:7}")"
    [ "$code" = 200 ] || return 1
  done
}

check() { # sets LATEST; returns 0 when up to date
  LATEST="${TARGET:-$(latest_sha)}"
  [ -n "$INSTALLED" ] && [ "$INSTALLED" = "$LATEST" ]
}

# Returns 0 after a successful update, 11 if it has to wait for images, 12 if
# the server is pinned to a release; anything else is a failure.
apply() {
  local tag; tag="$(get_env IMAGE_TAG)"
  if [ -z "$TARGET" ] && [ -n "$tag" ] && [ "$tag" != latest ]; then
    echo "This server is pinned to image version $tag (IMAGE_TAG in .env), so it is not"
    echo "updated automatically. To move it: ./install.sh --image-tag <new version>"
    return 12
  fi
  if ! images_ready "$LATEST"; then
    echo "Version ${LATEST:0:7} is out, but its images are not published yet (they take a few"
    echo "minutes to build). Nothing was changed; it will be tried again."
    return 11
  fi
  if $BACKUP && [ -x scripts/backup.sh ] && case "$(get_env ROLE)" in master|both) true ;; *) false ;; esac; then
    echo "Backing up the database first..."
    KEEP_DAYS="${KEEP_DAYS:-30}" ./scripts/backup.sh || { echo "The backup failed, so nothing was updated. Fix it, or pass --no-backup." >&2; return 1; }
  fi
  echo "Updating ${INSTALLED:0:7} -> ${LATEST:0:7}..."
  local script; script="$(mktemp)"
  if [ -n "$GET_SH" ]; then cp "$GET_SH" "$script"
  elif ! curl -fsSL -m 60 "https://raw.githubusercontent.com/$REPO/$LATEST/get.sh" -o "$script"; then
    echo "Could not download the installer for ${LATEST:0:7}." >&2; return 1
  fi
  # get.sh replaces the files (this script included) with new ones and re-runs
  # the installer with the existing settings.
  bash "$script" --dir "$DIR" --ref "$LATEST" --branch "${BRANCH:-main}" --non-interactive \
    ${TARBALL_OVERRIDE:+--tarball "$TARBALL_OVERRIDE"}
}

# One pass of the scheduler: act on what the dashboard (or the master) asks.
tick() {
  ensure_control
  # One update at a time; a stale lock from a killed run is cleared after an hour.
  local lock="$CONTROL/.update.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    [ -z "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ] && return 0
    rmdir "$lock" 2>/dev/null || true; mkdir "$lock" 2>/dev/null || return 0
  fi
  trap 'rmdir "$CONTROL/.update.lock" 2>/dev/null || true' EXIT

  write_kv "$STATUS" TICK "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_kv "$STATUS" SERVER_TIME "$(date +%H:%M)"
  write_kv "$STATUS" SERVER_ZONE "$(date +%Z)"
  write_kv "$STATUS" INSTALLED "$INSTALLED"

  local why=""
  if [ "$(get_env ROLE)" = slave ]; then
    # A slave follows its master: the engine notes the master's version here.
    [ "$(get_env UPDATE_FOLLOW_MASTER)" != false ] || return 0
    TARGET="$(head -n1 "$CONTROL/master-version" 2>/dev/null | tr -cd '0-9a-f')"
    [ ${#TARGET} -eq 40 ] && [ "$TARGET" != "$INSTALLED" ] || return 0
    why="to match the master"
  else
    local request handled auto at today now
    request="$(read_kv "$SETTINGS" REQUEST)"; handled="$(read_kv "$STATUS" HANDLED_REQUEST)"
    auto="$(read_kv "$SETTINGS" AUTO)"; at="$(read_kv "$SETTINGS" TIME)"
    today="$(date +%Y-%m-%d)"; now="$(date +%H:%M)"
    if [ "${request:-0}" -gt "${handled:-0}" ] 2>/dev/null; then
      write_kv "$STATUS" HANDLED_REQUEST "$request"
      why="requested from the dashboard"
    elif [ "$auto" = true ] && [ "$(read_kv "$STATUS" LAST_AUTO_DAY)" != "$today" ] && [ ! "$now" \< "${at:-04:15}" ]; then
      # Once a day, at or after the chosen time.
      write_kv "$STATUS" LAST_AUTO_DAY "$today"
      why="scheduled"
    else
      return 0
    fi
  fi

  local result=0
  if check; then
    report ok "Checked ($why): already on the latest version."
    return 0
  fi
  report running "Installing ${LATEST:0:7} ($why)..."
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] update $why: ${INSTALLED:0:7} -> ${LATEST:0:7}"
  apply || result=$?
  case "$result" in
    0) report ok "Updated to ${LATEST:0:7} ($why)."; write_kv "$STATUS" INSTALLED "$LATEST" ;;
    11) report waiting "Version ${LATEST:0:7} is out but its images are still being built; it will be tried again."
        # Let the next pass try again instead of waiting a day or for another click.
        [ "$why" != scheduled ] || write_kv "$STATUS" LAST_AUTO_DAY ""
        [ "$why" != "requested from the dashboard" ] || write_kv "$STATUS" HANDLED_REQUEST 0 ;;
    12) report ok "Not updated: this server is pinned to image version $(get_env IMAGE_TAG)." ;;
    *) report failed "The update to ${LATEST:0:7} failed; see update.log on the server." ;;
  esac
  return 0
}

case "$ACTION" in
  check)
    if check; then echo "Up to date (version ${INSTALLED:0:7}, branch ${BRANCH:-main})."; exit 0; fi
    echo "Update available: ${INSTALLED:0:7} -> ${LATEST:0:7} (branch ${BRANCH:-main})."
    echo "Install it with: scripts/update.sh"
    exit 10 ;;
  run|apply)
    if check; then echo "Up to date (version ${INSTALLED:0:7})."; exit 0; fi
    echo "Update available: ${INSTALLED:0:7} -> ${LATEST:0:7}."
    if [ "$ACTION" = run ] && ! $YES; then
      [ -t 0 ] || fail "No terminal to confirm on. Use: scripts/update.sh apply --yes"
      read -r -p "Install it now? Listeners are disconnected for a few seconds. [y/N] " answer
      case "$answer" in y|Y|yes|YES) ;; *) echo "Not updated."; exit 0 ;; esac
    fi
    ensure_control
    result=0; apply || result=$?
    [ "$result" != 0 ] || { report ok "Updated to ${LATEST:0:7} (by hand)."; write_kv "$STATUS" INSTALLED "$LATEST"; }
    exit "$result" ;;
  tick) tick ;;
  auto)
    ensure_control
    case "$SUB" in
      on)
        [ -z "$AT" ] || { printf '%s' "$AT" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' || fail "--time must be HH:MM, e.g. 04:15"; write_kv "$SETTINGS" TIME "$AT"; }
        write_kv "$SETTINGS" AUTO true
        echo "Automatic updates are on: every day at $(read_kv "$SETTINGS" TIME) (server time) this server checks"
        echo "$REPO (branch ${BRANCH:-main}) and installs what it finds." ;;
      off)
        write_kv "$SETTINGS" AUTO false
        echo "Automatic updates are off. The dashboard still shows when a newer version exists." ;;
      status|"")
        if [ "$(read_kv "$SETTINGS" AUTO)" = true ]; then echo "Automatic updates are on: $(read_kv "$SETTINGS" TIME) daily (server time)."
        else echo "Automatic updates are off."; fi
        if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$MARK"; then echo "The scheduler is installed."
        else echo "The scheduler is NOT installed, so nothing runs by itself. Fix: scripts/update.sh schedule install"; fi ;;
      *) fail "Use: scripts/update.sh auto on|off|status" ;;
    esac ;;
  schedule)
    command -v crontab >/dev/null 2>&1 || fail "cron is not installed on this server (crontab not found), so updates cannot be scheduled. Install cron, then run: scripts/update.sh schedule install"
    current="$(crontab -l 2>/dev/null || true)"
    kept="$(printf '%s\n' "$current" | grep -vF "$MARK" | grep -vF "# radio-gateway updater (" | grep -vF "# radio-gateway auto-update (" | sed '/^$/d' || true)"
    case "$SUB" in
      install)
        ensure_control
        { [ -z "$kept" ] || printf '%s\n' "$kept"; printf '*/5 * * * * cd %s && ./scripts/update.sh tick >> %s/update.log 2>&1 %s\n' "$DIR" "$DIR" "$MARK"; } | crontab -
        echo "The update scheduler is installed (it looks every 5 minutes for something to do)." ;;
      remove)
        printf '%s\n' "$kept" | crontab -
        echo "The update scheduler is removed." ;;
      *) fail "Use: scripts/update.sh schedule install|remove" ;;
    esac ;;
  *) fail "Unknown command: $ACTION (see: scripts/update.sh help)" ;;
esac
