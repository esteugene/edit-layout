#!/usr/bin/env bash
# Install the EDIT LAYOUT skill for Claude Code.
#
#   bash install.sh                 # from a checkout
#   curl -fsSL <raw>/install.sh | bash
#
# Installs one file: ~/.claude/skills/edit-layout/SKILL.md. The skill itself
# vendors the editor into whatever app you point it at, per review pass.
set -euo pipefail

REPO_URL="${EDIT_LAYOUT_REPO:-https://github.com/esteugene/edit-layout}"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/edit-layout"
REL="skills/edit-layout/SKILL.md"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$DEST"
  echo "EDIT LAYOUT skill removed from $DEST"
  exit 0
fi

# Running from a checkout? Use it. Piped from curl? Fetch one.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/$REL" ]; then
  src="$here"
else
  command -v git >/dev/null || { echo "install.sh: git is required" >&2; exit 1; }
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  git clone --depth 1 --quiet "$REPO_URL" "$tmp/edit-layout" ||
    { echo "install.sh: cannot read $REPO_URL — private repo? try: gh repo clone esteugene/edit-layout && bash edit-layout/install.sh" >&2; exit 1; }
  src="$tmp/edit-layout"
fi

mkdir -p "$DEST"
cp "$src/$REL" "$DEST/SKILL.md"

echo "EDIT LAYOUT skill installed to $DEST"
echo "Open a page in Claude Code and say:  /edit-layout   (or just \"attach the layout editor to /pricing\")"
