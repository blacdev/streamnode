#!/usr/bin/env bash
# Radio Gateway bootstrap: checks this server, downloads the code and starts
# the installer, which asks for everything else.
#
#   curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash
#
# Options go after "bash -s --". Those this script does not know are passed on
# to the installer (see ./install.sh --help), for example:
#
#   curl -fsSL .../get.sh | bash -s -- --role slave --master https://stream.example.com --token rgj_...
#
#   --repo URL      Git repository to install from (default: the one below)
#   --branch NAME   branch or tag to install (default: the repository's default branch)
#   --dir PATH      where to put the code (default: /opt/radio-gateway)
#   --yes           do not ask before installing Docker or other missing tools
#
# Running it again in the same directory updates the code and re-runs the installer,
# keeping existing settings and data.
set -euo pipefail

# The repository this script installs from. Set this once to your repository's
# address; RADIO_GATEWAY_REPO or --repo override it.
REPO_URL="${RADIO_GATEWAY_REPO:-https://github.com/blacdev/streamnode.git}"
BRANCH="${RADIO_GATEWAY_BRANCH:-}"
INSTALL_DIR="${RADIO_GATEWAY_DIR:-/opt/radio-gateway}"
ASSUME_YES=false
INSTALLER_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_URL="${2:?--repo needs a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --bootstrap-help) sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) INSTALLER_ARGS+=("$1"); shift ;;
  esac
done

say() { printf '%s\n' "$*"; }
ok() { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }
fail() { printf '\nError: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Piped from curl, standard input is the script itself, so questions are
# asked on the terminal directly. /dev/tty can exist without being usable
# (no controlling terminal, as under automation), so it is opened to find out.
if [ -t 0 ]; then TTY=/dev/stdin
elif (exec < /dev/tty) 2>/dev/null; then TTY=/dev/tty
else TTY=""; fi

confirm() { # confirm "Question" -> success on yes
  $ASSUME_YES && return 0
  [ -n "$TTY" ] || return 1
  local answer
  if [ "$TTY" = /dev/tty ]; then printf '%s [y/N] ' "$1" > /dev/tty; else printf '%s [y/N] ' "$1"; fi
  read -r answer < "$TTY" || return 1
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

say "Radio Gateway setup"
say

# ── This server ────────────────────────────────────────────────────────────

case "$REPO_URL" in
  *OWNER/REPO*) fail "This script has no repository address yet. Pass one: bash -s -- --repo https://github.com/<owner>/<repo>.git" ;;
esac
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
if [ "$memory_mb" -ge 1800 ]; then ok "${memory_mb} MB memory"
else warn "${memory_mb} MB memory: building the audio engine needs about 2 GB. Add swap if the build fails."; fi

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
for tool in git curl openssl; do have "$tool" || missing+=("$tool"); done
if [ ${#missing[@]} -gt 0 ]; then
  if confirm "Missing: ${missing[*]}. Install now?"; then
    install_packages "${missing[@]}" || fail "Could not install ${missing[*]} automatically. Install them and run this again."
  else
    fail "Install ${missing[*]} and run this again."
  fi
fi
ok "git, curl, openssl"

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
if have ss; then
  busy="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -oE '[0-9]+$' | sort -un | grep -xE '80|443|3000' | paste -sd' ' || true)"
  if [ -n "$busy" ]; then
    warn "Port(s) already in use on this server: $busy. A master uses 80 and 443, a slave node 3000."
  else
    ok "Ports 80, 443 and 3000 are free"
  fi
fi

# ── The code ───────────────────────────────────────────────────────────────

say
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating the code in $INSTALL_DIR"
  current="$($SUDO git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  [ "$current" = "$REPO_URL" ] || warn "That directory was installed from $current; keeping that source."
  if [ -n "$BRANCH" ]; then $SUDO git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH" && $SUDO git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"; fi
  $SUDO git -C "$INSTALL_DIR" pull --quiet --ff-only || fail "Could not update $INSTALL_DIR (local changes?). Resolve it with git and run this again."
elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  fail "$INSTALL_DIR exists and is not empty. Choose another place with --dir, or remove it."
else
  say "Downloading the code to $INSTALL_DIR"
  $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -n "$BRANCH" ]; then
    $SUDO git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  else
    $SUDO git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi || fail "Could not download $REPO_URL. Check the address and, for a private repository, your access."
fi
[ -x "$INSTALL_DIR/install.sh" ] || fail "$INSTALL_DIR does not contain the gateway installer."
ok "Code is in $INSTALL_DIR ($($SUDO git -C "$INSTALL_DIR" log -1 --format='%h, %cs' 2>/dev/null || echo 'version unknown'))"

# ── Hand over to the installer ─────────────────────────────────────────────

say
say "Starting the installer. It asks which role this server has and what it needs."
say
cd "$INSTALL_DIR"
if [ -n "$TTY" ] && [ "$TTY" != /dev/stdin ]; then
  exec $SUDO ./install.sh "${INSTALLER_ARGS[@]}" < "$TTY"
else
  exec $SUDO ./install.sh "${INSTALLER_ARGS[@]}"
fi
