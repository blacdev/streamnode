#!/usr/bin/env bash
# StreamNode bootstrap: checks this server, downloads what the gateway needs
# to run and starts the installer, which asks for everything else.
#
#   curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash
#
# The services run from prebuilt Docker images, so only a handful of files are
# placed on the server (the Compose file, the proxy configuration and the
# operational scripts), not the source code.
#
# Options go after "bash -s --". Those this script does not know are passed on
# to the installer (see ./install.sh --help), for example:
#
#   curl -fsSL .../get.sh | bash -s -- --role slave --master https://stream.example.com --token rgj_...
#
#   --dir PATH         where to install (default: /opt/streamnode)
#   --branch NAME      branch to install and to follow for updates (default: the repository's default)
#   --ref COMMIT       install exactly this commit
#   --repo URL         install from another GitHub repository (a fork)
#   --with-source      also keep the source code, for building the images on this server
#   --yes              do not ask before installing Docker or other missing tools
#   --non-interactive  never ask anything; use what is already configured
#
# Running it again in the same directory updates the files and re-runs the
# installer, keeping existing settings and data. scripts/update.sh does that for you.
set -euo pipefail

# The repository this script installs from; STREAMNODE_REPO or --repo override it.
# (The RADIO_GATEWAY_* names, from before the project was renamed, still work.)
REPO_URL="${STREAMNODE_REPO:-${RADIO_GATEWAY_REPO:-https://github.com/blacdev/streamnode.git}}"
BRANCH="${STREAMNODE_BRANCH:-${RADIO_GATEWAY_BRANCH:-}}"
INSTALL_DIR="${STREAMNODE_DIR:-${RADIO_GATEWAY_DIR:-}}"
DIR_GIVEN=true
if [ -z "$INSTALL_DIR" ]; then
  DIR_GIVEN=false
  INSTALL_DIR=/opt/streamnode
fi
REF="" TARBALL="" WITH_SOURCE=false ASSUME_YES=false INTERACTIVE=true
INSTALLER_ARGS=()

# Everything a server needs to run and operate the gateway. Kept in step with
# the repository by a CI check.
RUNTIME_FILES="docker-compose.yml docker-compose.build.yml haproxy.cfg .env.example install.sh scripts/add-server.sh scripts/backup.sh scripts/restore.sh scripts/letsencrypt.sh scripts/uninstall.sh scripts/update.sh scripts/migrate.sh"
# Only needed to compile the images here instead of downloading them.
SOURCE_DIRS="rust_src admin_src"
# Left behind by earlier installs that cloned the whole repository.
OBSOLETE="demo docs .git .github README.md CHANGELOG.md CONTRIBUTING.md get.sh docker-compose.demo.yml .gitignore .gitattributes scripts/try-local.sh scripts/set-repo.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_URL="${2:?--repo needs a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:?--dir needs a value}"; DIR_GIVEN=true; shift 2 ;;
    --tarball) TARBALL="${2:?--tarball needs a value}"; shift 2 ;;
    --with-source) WITH_SOURCE=true; shift ;;
    --build-from-source) WITH_SOURCE=true; INSTALLER_ARGS+=("$1"); shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --non-interactive) INTERACTIVE=false; ASSUME_YES=true; shift ;;
    *) INSTALLER_ARGS+=("$1"); shift ;;
  esac
done

# A server installed before the project was renamed lives in /opt/radio-gateway.
# It is moved to /opt/streamnode (further down, once we know how to become
# root), leaving a link at the old path so that anything still pointing there
# keeps working. It is never installed a second time beside itself.
OLD_DIR=/opt/radio-gateway
NEW_DIR=/opt/streamnode
MOVE_DIR=false
if [ -e "$OLD_DIR/install.sh" ] && [ ! -L "$OLD_DIR" ] && [ ! -e "$NEW_DIR" ] && { ! $DIR_GIVEN || [ "${INSTALL_DIR%/}" = "$OLD_DIR" ]; }; then
  MOVE_DIR=true
  INSTALL_DIR="$NEW_DIR"
elif ! $DIR_GIVEN && [ ! -e "$NEW_DIR/install.sh" ] && [ -e "$OLD_DIR/install.sh" ]; then
  INSTALL_DIR="$OLD_DIR"
fi

say() { printf '%s\n' "$*"; }
ok() { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }
fail() { printf '\nError: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Piped from curl, standard input is the script itself, so questions are
# asked on the terminal directly. /dev/tty can exist without being usable
# (no controlling terminal, as under automation), so it is opened to find out.
TTY=""
if $INTERACTIVE; then
  if [ -t 0 ]; then TTY=/dev/stdin
  elif (exec < /dev/tty) 2>/dev/null; then TTY=/dev/tty; fi
fi

confirm() { # confirm "Question" -> success on yes
  $ASSUME_YES && return 0
  [ -n "$TTY" ] || return 1
  local answer
  if [ "$TTY" = /dev/tty ]; then printf '%s [y/N] ' "$1" > /dev/tty; else printf '%s [y/N] ' "$1"; fi
  read -r answer < "$TTY" || return 1
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

say "StreamNode setup"
say

# ── This server ────────────────────────────────────────────────────────────

[ "$(uname -s)" = Linux ] || fail "The gateway runs on Linux servers; this is $(uname -s)."
case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ok "Linux $(uname -m)" ;;
  *) fail "Unsupported processor: $(uname -m). A 64-bit x86 or ARM server is needed." ;;
esac

if [ "$(id -u)" -eq 0 ]; then SUDO=""
elif have sudo; then SUDO="sudo"
else fail "Run this as root, or install sudo."; fi
if [ -n "$SUDO" ]; then
  say "  Administrator rights are needed to install software and start Docker."
  $SUDO -v < "${TTY:-/dev/null}" || fail "Could not get administrator rights."
fi

memory_mb="$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$memory_mb" -ge 900 ]; then ok "${memory_mb} MB memory"
else warn "${memory_mb} MB memory is tight; 1 GB or more is recommended."; fi

# ── Tools ──────────────────────────────────────────────────────────────────

install_packages() { # install_packages NAME...
  if have apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$@"
  elif have dnf; then $SUDO dnf install -y -q "$@"
  elif have yum; then $SUDO yum install -y -q "$@"
  elif have zypper; then $SUDO zypper --non-interactive install "$@"
  elif have pacman; then $SUDO pacman -S --noconfirm --needed "$@"
  elif have apk; then $SUDO apk add --no-cache "$@"
  else return 1; fi
}

missing=()
for tool in curl tar openssl; do have "$tool" || missing+=("$tool"); done
if [ ${#missing[@]} -gt 0 ]; then
  if confirm "Missing: ${missing[*]}. Install now?"; then
    install_packages "${missing[@]}" || fail "Could not install ${missing[*]} automatically. Install them and run this again."
  else
    fail "Install ${missing[*]} and run this again."
  fi
fi
ok "curl, tar, openssl"

if ! have docker; then
  say "  Docker is not installed."
  if confirm "Install Docker now with Docker's official script (https://get.docker.com)?"; then
    curl -fsSL https://get.docker.com | $SUDO sh || fail "Docker installation failed. See https://docs.docker.com/engine/install/"
  else
    fail "Docker is required. Install it (https://docs.docker.com/engine/install/) and run this again."
  fi
fi
ok "$(docker --version 2>/dev/null | cut -d, -f1)"

if ! $SUDO docker info >/dev/null 2>&1; then
  if have systemctl; then $SUDO systemctl enable --now docker >/dev/null 2>&1 || true; fi
  sleep 2
  $SUDO docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start it (sudo systemctl start docker) and run this again."
fi
ok "Docker is running"

if $MOVE_DIR; then
  if $SUDO mv "$OLD_DIR" "$NEW_DIR" && $SUDO ln -s "$NEW_DIR" "$OLD_DIR"; then
    # Scheduled jobs (updates, backups, certificate renewal) follow the move.
    if have crontab && crontab -l 2>/dev/null | grep -qF "$OLD_DIR"; then
      crontab -l 2>/dev/null | sed "s#$OLD_DIR#$NEW_DIR#g" | crontab - || warn "Could not update the scheduled jobs; they still work through $OLD_DIR."
    fi
    ok "Moved the installation from $OLD_DIR to $NEW_DIR (a link is left at the old path)"
  else
    warn "Could not move $OLD_DIR to $NEW_DIR; updating it where it is."
    [ -e "$OLD_DIR/install.sh" ] && INSTALL_DIR="$OLD_DIR"
  fi
fi

if ! $SUDO docker compose version >/dev/null 2>&1; then
  say "  The Docker Compose plugin is missing."
  if confirm "Install it now?"; then
    install_packages docker-compose-plugin || install_packages docker-compose || fail "Could not install Docker Compose. See https://docs.docker.com/compose/install/"
  else
    fail "Docker Compose is required. See https://docs.docker.com/compose/install/"
  fi
  $SUDO docker compose version >/dev/null 2>&1 || fail "Docker Compose is still not available. See https://docs.docker.com/compose/install/"
fi
ok "Docker Compose $($SUDO docker compose version --short 2>/dev/null)"

# Not fatal: which ports matter depends on the role chosen in the next step.
if have ss && [ ! -f "$INSTALL_DIR/.env" ]; then
  busy="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -oE '[0-9]+$' | sort -un | grep -xE '80|443|3000' | paste -sd' ' || true)"
  if [ -n "$busy" ]; then
    warn "Port(s) already in use on this server: $busy. A master uses 80 and 443 (see --http-port), a slave node 3000."
  else
    ok "Ports 80, 443 and 3000 are free"
  fi
fi

# ── The files ──────────────────────────────────────────────────────────────

slug="${REPO_URL#*github.com[:/]}"; slug="${slug%.git}"; slug="${slug%/}"
case "$slug" in */*) ;; *) [ -n "$TARBALL" ] || fail "Not a GitHub repository address: $REPO_URL" ;; esac

# An existing install keeps following the branch it was installed from.
if [ -z "$BRANCH" ] && [ -f "$INSTALL_DIR/.version" ]; then
  BRANCH="$($SUDO sed -n 's/^BRANCH=//p' "$INSTALL_DIR/.version" | head -n1)"
fi
if [ -z "$BRANCH" ] && [ -z "$TARBALL" ]; then
  BRANCH="$(curl -fsSL -m 20 "https://api.github.com/repos/$slug" 2>/dev/null | sed -n 's/.*"default_branch": *"\([^"]*\)".*/\1/p' | head -n1 || true)"
fi
[ -n "$BRANCH" ] || BRANCH=main
# Pin the download to one commit, so the files and the recorded version agree.
if [ -z "$REF" ] && [ -z "$TARBALL" ]; then
  REF="$(curl -fsSL -m 20 -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$slug/commits/$BRANCH" 2>/dev/null || true)"
  case "$REF" in *[!0-9a-f]*|"") REF="" ;; esac
fi
[ -n "$TARBALL" ] || TARBALL="https://codeload.github.com/$slug/tar.gz/${REF:-$BRANCH}"

# Building from source was chosen earlier for this server: keep doing so.
if [ -f "$INSTALL_DIR/.env" ] && $SUDO grep -q '^INSTALL_FROM=source' "$INSTALL_DIR/.env"; then WITH_SOURCE=true; fi

say
if [ -f "$INSTALL_DIR/install.sh" ]; then
  say "Updating the gateway files in $INSTALL_DIR"
elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  fail "$INSTALL_DIR exists and is not empty. Choose another place with --dir, or remove it."
else
  say "Downloading the gateway files to $INSTALL_DIR"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL -m 120 "$TARBALL" -o "$work/bundle.tar.gz" || fail "Could not download $TARBALL. Check the address and, for a private repository, your access."
mkdir "$work/src"
tar -xzf "$work/bundle.tar.gz" -C "$work/src" --strip-components=1 || fail "The download is not a valid archive."
[ -f "$work/src/install.sh" ] && [ -f "$work/src/docker-compose.yml" ] || fail "The download does not contain the gateway."

$SUDO mkdir -p "$INSTALL_DIR/scripts" "$INSTALL_DIR/certs"
for file in $RUNTIME_FILES; do
  [ -f "$work/src/$file" ] || fail "The download is missing $file."
  $SUDO install -m "$( [ -x "$work/src/$file" ] && echo 755 || echo 644 )" "$work/src/$file" "$INSTALL_DIR/$file"
done
# Source code only where images are built on this server; otherwise it is not
# kept, including what an earlier full copy left behind.
for dir in $SOURCE_DIRS; do
  $SUDO rm -rf "${INSTALL_DIR:?}/$dir"
  if $WITH_SOURCE; then $SUDO cp -R "$work/src/$dir" "$INSTALL_DIR/$dir"; fi
done
for item in $OBSOLETE; do $SUDO rm -rf "${INSTALL_DIR:?}/$item"; done
[ -f "$INSTALL_DIR/edge/.env" ] || $SUDO rm -rf "${INSTALL_DIR:?}/edge"

printf 'REPO=%s\nBRANCH=%s\nSHA=%s\nTARBALL=%s\nINSTALLED_AT=%s\n' "$slug" "$BRANCH" "$REF" "$TARBALL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | $SUDO tee "$INSTALL_DIR/.version" >/dev/null
ok "Files are in $INSTALL_DIR (version ${REF:0:7}${REF:+, }branch $BRANCH; $($SUDO du -sh "$INSTALL_DIR" 2>/dev/null | cut -f1) on disk)"

# ── Hand over to the installer ─────────────────────────────────────────────

say
say "Starting the installer."
say
cd "$INSTALL_DIR"
if [ "$TTY" = /dev/tty ]; then
  exec $SUDO ./install.sh "${INSTALLER_ARGS[@]}" < /dev/tty
elif [ -n "$TTY" ]; then
  exec $SUDO ./install.sh "${INSTALLER_ARGS[@]}"
else
  exec $SUDO ./install.sh "${INSTALLER_ARGS[@]}" < /dev/null
fi
