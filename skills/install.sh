#!/bin/sh
# brain skills installer (POSIX sh — bash, dash, busybox ash).
#
# Usage:
#   curl -fsSL https://brain.inite.ai/install.sh | sh
#   curl -fsSL https://brain.inite.ai/install.sh | sh -s -- --target project
#
# Default: installs into ~/.claude/skills/ (user-global).
# --target project installs into $PWD/.claude/skills/.
#
# There used to be a --key flag here that POSTed to an "install probe"
# so a dashboard could mark the step done. No such endpoint was ever
# built and there is no such dashboard step, but the script printed
# "Notified dashboard." unconditionally — the curl was `|| true`. Both
# are gone. When the onboarding checklist ships, the flag comes back
# with an endpoint behind it. Unknown flags are still ignored, so an
# older command line with --key keeps working.
set -e

TARGET_MODE="user"
SKILLS_URL="${BRAIN_SKILLS_URL-https://brain.inite.ai/skills.tar.gz}"

while [ $# -gt 0 ]; do
  case "$1" in
    --target=user)    TARGET_MODE="user"; shift ;;
    --target=project) TARGET_MODE="project"; shift ;;
    --target)         shift; TARGET_MODE="$1"; shift ;;
    --help|-h)
      echo "Usage: install.sh [--target user|project]"
      echo "  user    (default) install into ~/.claude/skills/"
      echo "  project install into \$PWD/.claude/skills/"
      exit 0
      ;;
    *) shift ;;
  esac
done

if [ "$TARGET_MODE" = "project" ]; then
  TARGET_DIR="$PWD/.claude/skills"
else
  TARGET_DIR="$HOME/.claude/skills"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "-> Fetching brain skills from $SKILLS_URL"
if ! command -v curl >/dev/null 2>&1; then
  echo "! curl not found - please install curl." >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "! tar not found - please install tar." >&2
  exit 1
fi
curl -fsSL "$SKILLS_URL" -o "$TMP_DIR/skills.tar.gz"
mkdir -p "$TMP_DIR/extract"
tar -xzf "$TMP_DIR/skills.tar.gz" -C "$TMP_DIR/extract"

# Tarball layout: top-level `skills/` directory.
SRC="$TMP_DIR/extract/skills"
if [ ! -d "$SRC" ]; then
  echo "! Skills folder not found in tarball." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
echo "-> Installing to $TARGET_DIR"
INSTALLED=0
for skill in "$SRC"/*/; do
  [ -d "$skill" ] || continue
  name="$(basename "$skill")"
  rm -rf "$TARGET_DIR/$name"
  cp -r "$skill" "$TARGET_DIR/$name"
  INSTALLED=$((INSTALLED + 1))
  echo "   + $name"
done

# Bundle VERSION + CHANGELOG live alongside so the staleness check has
# a single number to compare against.
if [ -f "$SRC/VERSION" ]; then
  cp "$SRC/VERSION" "$TARGET_DIR/VERSION.brain"
fi
if [ -f "$SRC/CHANGELOG.md" ]; then
  cp "$SRC/CHANGELOG.md" "$TARGET_DIR/CHANGELOG.brain.md"
fi

echo ""
echo "Installed $INSTALLED brain skills into $TARGET_DIR (bundle $(cat "$TARGET_DIR/VERSION.brain" 2>/dev/null || echo unknown))"
echo ""

echo "Next: add brain to your MCP client config. See:"
echo "      https://brain.inite.ai/en/docs/mcp/setup"
