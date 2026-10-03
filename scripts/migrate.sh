#!/usr/bin/env bash
# Brings an installation made by an older version into line with the current
# one. install.sh runs this by itself on every run, so nobody has to; it only
# acts on what it finds and is safe to run any number of times.
#
#   scripts/migrate.sh prepare   before the services start: settings and version record
#   scripts/migrate.sh slim      after they are running from prebuilt images: remove
#                                the source code and other files a server does not need
#   scripts/migrate.sh slim --force   the same for a full "git clone" made by hand, which
#                                is otherwise left alone in case it is a development copy
#   scripts/migrate.sh drop-old-data  remove the data volumes kept as a backup after the
#                                move from the old project name (radio-gateway)
#
# What it handles:
#   - installs that are a full copy (git clone) of the repository
#   - settings (.env) written before roles, certificate modes, the Redis
#     password, the engine secret or prebuilt images existed
#   - settings that refer to files which no longer exist
#   - the daily update entry used before the dashboard-controlled updater
#   - servers installed before the project was renamed from radio-gateway
set -euo pipefail
cd "$(dirname "$0")/.."

PHASE="${1:-prepare}"
FORCE=false; [ "${2:-}" != --force ] || FORCE=true
changed=false
note() { changed=true; echo "  migrate: $*"; }

get_env() { [ -f .env ] && grep "^$1=" .env | head -n1 | cut -d= -f2- || true; }
has_env() { [ -f .env ] && grep -q "^$1=" .env; }
set_env() {
  local tmp; tmp="$(mktemp)"
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}
unset_env() {
  local tmp; tmp="$(mktemp)"
  grep -v "^$1=" .env > "$tmp" || true
  cat "$tmp" > .env && rm -f "$tmp"
}

# Whether a git working copy here is an installation rather than somebody's
# development copy. The one-line installer made shallow clones; a clone with
# full history, or with local changes, is assumed to be a developer's and is
# never deleted without --force.
is_installer_clone() {
  [ -d .git ] && command -v git >/dev/null 2>&1 || return 1
  [ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || return 1
  $FORCE || [ -f .git/shallow ]
}

OLD_PROJECT=radio-gateway
NEW_PROJECT=streamnode

# The project was renamed from radio-gateway to streamnode. Docker names
# containers and data volumes after the project, so a server set up under the
# old name has its database, statistics, uploads and enrolment in volumes
# called radio-gateway_*. This copies each one to its streamnode_* name and
# removes the old containers, after which the server starts under the new name
# with all of its data. The old volumes are not touched: they are the backup,
# removed later with "scripts/migrate.sh drop-old-data". If anything goes
# wrong nothing is lost: the copies are discarded and the server carries on
# under its old name.
rename_project() {
  command -v docker >/dev/null 2>&1 || return 0
  # Set by an earlier run that could not move the data, or by the operator.
  ! has_env COMPOSE_PROJECT_NAME || return 0
  local containers volumes volume new helper="" image created="" failed=""
  containers="$(docker ps -aq --filter "label=com.docker.compose.project=$OLD_PROJECT" 2>/dev/null || true)"
  volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$OLD_PROJECT" 2>/dev/null || true)"
  [ -n "$containers$volumes" ] || return 0
  if [ -z "$containers" ]; then
    # Nothing runs under the old name. If every old volume has its new one, the move was done before.
    local pending=false
    for volume in $volumes; do
      docker volume inspect "${NEW_PROJECT}_${volume#"${OLD_PROJECT}"_}" >/dev/null 2>&1 || pending=true
    done
    $pending || return 0
  fi

  echo "  migrate: this server was installed as \"$OLD_PROJECT\". Moving its data to \"$NEW_PROJECT\"..."
  # Something with a shell and cp to do the copying: an image already on this server, if possible.
  for image in postgres:16-alpine redis:7-alpine haproxy:2.8-alpine alpine:3.20; do
    if docker image inspect "$image" >/dev/null 2>&1; then helper="$image"; break; fi
  done
  if [ -z "$helper" ] && docker pull -q alpine:3.20 >/dev/null 2>&1; then helper=alpine:3.20; fi

  # The services stop first, so that the database is copied at rest.
  # shellcheck disable=SC2086
  [ -z "$containers" ] || docker stop -t 30 $containers >/dev/null 2>&1 || true
  if [ -z "$helper" ]; then
    failed="no image could be found or downloaded to copy with"
  else
    for volume in $volumes; do
      new="${NEW_PROJECT}_${volume#"${OLD_PROJECT}"_}"
      if docker volume inspect "$new" >/dev/null 2>&1; then
        failed="a volume named $new already exists"; break
      fi
      if ! docker volume create --label "com.docker.compose.project=$NEW_PROJECT" \
             --label "com.docker.compose.volume=${volume#"${OLD_PROJECT}"_}" "$new" >/dev/null 2>&1; then
        failed="could not create $new"; break
      fi
      created="$created $new"
      if ! docker run --rm --user 0 --entrypoint sh -v "$volume":/from:ro -v "$new":/to "$helper" -c 'cp -a /from/. /to/' >/dev/null 2>&1; then
        failed="could not copy $volume (is the disk full?)"; break
      fi
      echo "  migrate:   copied $volume -> $new"
    done
  fi

  if [ -n "$failed" ]; then
    # shellcheck disable=SC2086
    [ -z "$created" ] || docker volume rm $created >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    [ -z "$containers" ] || docker start $containers >/dev/null 2>&1 || true
    set_env COMPOSE_PROJECT_NAME "$OLD_PROJECT"
    note "the data was NOT moved ($failed). Nothing is lost: this server keeps its old internal name (COMPOSE_PROJECT_NAME=$OLD_PROJECT in .env). To try again, fix the cause, remove that line and run ./install.sh"
    return 0
  fi

  # shellcheck disable=SC2086
  [ -z "$containers" ] || docker rm -f $containers >/dev/null 2>&1 || true
  local networks
  networks="$(docker network ls -q --filter "label=com.docker.compose.project=$OLD_PROJECT" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -z "$networks" ] || docker network rm $networks >/dev/null 2>&1 || true
  note "moved this server's data to the new name. The old volumes are kept as a backup; once you have seen that everything is in place, free the space with: scripts/migrate.sh drop-old-data"
}

# Removes the volumes left under the old project name, once the new ones are in use.
drop_old_data() {
  command -v docker >/dev/null 2>&1 || { echo "Docker is not installed." >&2; exit 1; }
  if has_env COMPOSE_PROJECT_NAME && [ "$(get_env COMPOSE_PROJECT_NAME)" = "$OLD_PROJECT" ]; then
    echo "This server still runs under its old name, so those volumes are its data. Nothing was removed." >&2; exit 1
  fi
  if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$OLD_PROJECT" 2>/dev/null)" ]; then
    echo "Services are still running under the old name. Run ./install.sh first. Nothing was removed." >&2; exit 1
  fi
  local volume removed=0
  for volume in $(docker volume ls -q --filter "label=com.docker.compose.project=$OLD_PROJECT" 2>/dev/null); do
    if ! docker volume inspect "${NEW_PROJECT}_${volume#"${OLD_PROJECT}"_}" >/dev/null 2>&1; then
      echo "Kept $volume: it has no copy under the new name."; continue
    fi
    docker volume rm "$volume" >/dev/null && { echo "Removed $volume"; removed=$((removed + 1)); }
  done
  echo "$removed old volume(s) removed."
}

prepare() {
  # ── Where this installation came from ────────────────────────────────────
  if [ ! -f .version ] && [ -d .git ] && command -v git >/dev/null 2>&1; then
    local remote slug branch sha
    remote="$(git remote get-url origin 2>/dev/null || true)"
    case "$remote" in
      *github.com[:/]*)
        slug="${remote#*github.com[:/]}"; slug="${slug%.git}"; slug="${slug%/}"
        branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
        [ "$branch" != HEAD ] || branch=main
        sha="$(git rev-parse HEAD 2>/dev/null || true)"
        printf 'REPO=%s\nBRANCH=%s\nSHA=%s\nTARBALL=%s\nINSTALLED_AT=%s\n' "$slug" "$branch" "$sha" \
          "https://codeload.github.com/$slug/tar.gz/$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .version
        note "recorded the installed version (${sha:0:7}, branch $branch) so updates can be tracked" ;;
    esac
  fi

  [ -f .env ] || return 0

  # ── Settings from before roles existed: those were single-server installs ─
  if ! has_env ROLE && { has_env POSTGRES_PASSWORD || has_env ADMIN_API_KEY; }; then
    set_env ROLE both
    note "this server predates roles; recorded it as a single server (role: both)"
  fi

  # ── Certificate mode, from the certificate that is actually in place ──────
  if ! has_env TLS_MODE && [ "$(get_env ROLE)" != slave ]; then
    local mode=selfsigned issuer subject
    if [ -s certs/stream.pem ] && command -v openssl >/dev/null 2>&1; then
      issuer="$(openssl x509 -in certs/stream.pem -noout -issuer 2>/dev/null | sed 's/^issuer= *//')"
      subject="$(openssl x509 -in certs/stream.pem -noout -subject 2>/dev/null | sed 's/^subject= *//')"
      if [ -n "$issuer" ] && [ "$issuer" != "$subject" ]; then
        case "$issuer" in *"Let's Encrypt"*|*"ISRG"*) mode=letsencrypt ;; *) mode=provided ;; esac
      fi
    fi
    set_env TLS_MODE "$mode"
    note "recorded how HTTPS is provided, from the certificate in place: $mode"
  fi

  rename_project

  # ── Settings that point at files which no longer exist ───────────────────
  local compose_file; compose_file="$(get_env COMPOSE_FILE)"
  if [ -n "$compose_file" ]; then
    local part missing=false
    for part in $(printf '%s' "$compose_file" | tr ':' ' '); do [ -f "$part" ] || missing=true; done
    if $missing; then
      unset_env COMPOSE_FILE
      note "removed COMPOSE_FILE, which named a file that no longer exists ($compose_file)"
    fi
  fi
  # The private Redis port for other servers became CLUSTER_BIND (Redis over TLS on 6380).
  local old
  for old in REDIS_BIND PRIVATE_BIND; do
    if has_env "$old"; then
      [ -z "$(get_env "$old")" ] || has_env CLUSTER_BIND || set_env CLUSTER_BIND 0.0.0.0
      unset_env "$old"
      note "replaced $old with CLUSTER_BIND; servers added under the old scheme must join again (scripts/add-server.sh)"
    fi
  done
  if has_env EDGE_RELAY_PORT; then
    has_env RELAY_PORT || set_env RELAY_PORT "$(get_env EDGE_RELAY_PORT)"
    unset_env EDGE_RELAY_PORT
    note "renamed EDGE_RELAY_PORT to RELAY_PORT"
  fi

  # ── The daily update entry is replaced by the dashboard-controlled updater ─
  if command -v crontab >/dev/null 2>&1; then
    local old_mark="# radio-gateway auto-update ($(pwd))" current line
    current="$(crontab -l 2>/dev/null || true)"
    if printf '%s\n' "$current" | grep -qF "$old_mark"; then
      line="$(printf '%s\n' "$current" | grep -F "$old_mark" | head -n1)"
      mkdir -p control
      printf 'AUTO=true\nTIME=%02d:%02d\nREQUEST=0\n' "$(printf '%s' "$line" | awk '{print $2 + 0}')" "$(printf '%s' "$line" | awk '{print $1 + 0}')" > control/update-settings
      { printf '%s\n' "$current" | grep -vF "$old_mark" || true; } | crontab -
      note "moved the daily automatic update into the new updater, keeping its time"
    fi
  fi

  # ── An engine installed with the old node/ layout cannot be converted ─────
  if [ -f node/.env ]; then
    echo "  migrate: node/.env is a streaming server set up the old way. It has to join its master"
    echo "           again: on the master run scripts/add-server.sh, then run the command it prints here."
  fi
}

slim() {
  [ -f .version ] || return 0
  # Source is kept where images are built on this server.
  [ "$(get_env INSTALL_FROM)" != source ] || return 0
  if [ -d .git ]; then
    if ! is_installer_clone; then
      echo "  migrate: this directory is a git working copy that may be a development copy, so its"
      echo "           source code is left in place. To remove it anyway: scripts/migrate.sh slim --force"
      return 0
    fi
  fi
  local before after item removed=false
  before="$(du -sk . 2>/dev/null | cut -f1)"
  for item in rust_src admin_src demo docs .git .github README.md CHANGELOG.md CONTRIBUTING.md get.sh \
              docker-compose.demo.yml docker-compose.cluster.yml .gitignore .gitattributes init.sql \
              scripts/try-local.sh scripts/set-repo.sh; do
    if [ -e "$item" ]; then rm -rf "${item:?}"; removed=true; fi
  done
  [ -f node/.env ] || { [ ! -e node ] || { rm -rf node; removed=true; }; }
  [ -f edge/.env ] || { [ ! -e edge ] || { rm -rf edge; removed=true; }; }
  if $removed; then
    after="$(du -sk . 2>/dev/null | cut -f1)"
    note "removed the source code and other files a running server does not need ($((before - after)) KB freed)"
  fi
}

case "$PHASE" in
  prepare) prepare ;;
  slim) slim ;;
  drop-old-data) drop_old_data ;;
  *) echo "Usage: scripts/migrate.sh prepare|slim|drop-old-data" >&2; exit 1 ;;
esac
$changed && echo "  migrate: done." || true
