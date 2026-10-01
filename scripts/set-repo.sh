#!/usr/bin/env bash
# Run once before publishing: writes your repository's address into the
# one-line installer and the documentation, replacing the OWNER/REPO placeholder.
#
#   scripts/set-repo.sh https://github.com/acme/radio-gateway
#   scripts/set-repo.sh https://github.com/acme/radio-gateway main     # if the default branch is not "main"
set -euo pipefail
cd "$(dirname "$0")/.."

url="${1:-}"; branch="${2:-main}"
url="${url%.git}"; url="${url%/}"
case "$url" in
  https://github.com/*/*) ;;
  *) echo "Usage: scripts/set-repo.sh https://github.com/<owner>/<repo> [branch]" >&2; exit 1 ;;
esac
slug="${url#https://github.com/}"

files="get.sh README.md docs/INSTALLATION.md"
grep -q "OWNER/REPO" README.md || { echo "The repository address is already set (no OWNER/REPO placeholder left)." >&2; exit 1; }
for file in $files; do
  sed -i -e "s|raw.githubusercontent.com/OWNER/REPO/main|raw.githubusercontent.com/$slug/$branch|g" \
         -e "s|github.com/OWNER/REPO|github.com/$slug|g" "$file"
done
echo "Set to $url (branch $branch). The install command is now:"
echo
echo "  curl -fsSL https://raw.githubusercontent.com/$slug/$branch/get.sh | bash"
