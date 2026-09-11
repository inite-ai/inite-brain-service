#!/bin/sh
# brain skills installer (POSIX sh — bash, dash, busybox ash).
#
# Usage:
#   curl -fsSL https://brain.inite.ai/install.sh | sh
#   curl -fsSL https://brain.inite.ai/install.sh | sh -s -- --target all
#   curl -fsSL https://brain.inite.ai/install.sh | sh -s -- --target codex,gemini
#   curl -fsSL https://brain.inite.ai/install.sh | sh -s -- --scope project
#
# SKILL.md became a cross-agent format in 2026 — the same six skills work
# unchanged in Claude Code, Codex CLI, Gemini CLI, Cursor, opencode and
# openclaw. Each agent reads its own directory, so the only thing that
# ever differed was the destination path. Default is autodetect: every
# agent whose home directory already exists gets the bundle.
#
# There used to be a --key flag here that POSTed to an "install probe"
# so a dashboard could mark the step done. No such endpoint was ever
# built and there is no such dashboard step, but the script printed
# "Notified dashboard." unconditionally — the curl was `|| true`. Both
# are gone. When the onboarding checklist ships, the flag comes back
# with an endpoint behind it. Unknown flags are still ignored, so an
# older command line with --key keeps working.
set -e

SKILLS_URL="${BRAIN_SKILLS_URL-https://brain.inite.ai/skills.tar.gz}"
TARGETS=""
SCOPE=""
DRY_RUN=0

# ── Target table ─────────────────────────────────────────────────────
#
# One function instead of an associative array, because POSIX sh has no
# arrays. Prints "<user-path>|<project-path>|<detect-path>"; an empty
# field means that agent has no such directory (Cursor is project-only;
# `agents` is the vendor-neutral project convention with no user form).
#
# Two agents let the user move their whole state directory, and both are
# honoured: CODEX_HOME for Codex CLI, OPENCLAW_STATE_DIR for openclaw.
# Installing into ~/.openclaw on a machine where the state lives
# elsewhere is a silent no-op — the skills land somewhere nothing reads.
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
OPENCLAW_ROOT="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

target_paths() {
  case "$1" in
    claude)   echo "$HOME/.claude/skills|$PWD/.claude/skills|$HOME/.claude" ;;
    codex)    echo "$CODEX_ROOT/skills|$PWD/.codex/skills|$CODEX_ROOT" ;;
    gemini)   echo "$HOME/.gemini/skills|$PWD/.gemini/skills|$HOME/.gemini" ;;
    openclaw) echo "$OPENCLAW_ROOT/skills|$PWD/.openclaw/skills|$OPENCLAW_ROOT" ;;
    opencode) echo "$HOME/.config/opencode/skills|$PWD/.opencode/skills|$HOME/.config/opencode" ;;
    cursor)   echo "|$PWD/.cursor/skills|$HOME/.cursor" ;;
    agents)   echo "|$PWD/.agents/skills|" ;;
    *)        echo "" ;;
  esac
}

ALL_TARGETS="claude codex gemini openclaw opencode cursor agents"

usage() {
  echo "Usage: install.sh [--target <ids>] [--scope user|project] [--list] [--dry-run]"
  echo ""
  echo "  --target auto     (default) every agent already installed on this machine"
  echo "  --target all      every agent this script knows about"
  echo "  --target a,b,c    a comma-separated subset of:"
  echo "                    claude codex gemini openclaw opencode cursor agents"
  echo "  --scope  user     (default) install into the agent's home directory"
  echo "  --scope  project  install into \$PWD (the only scope cursor + agents have)"
  echo "  --list            print the resolved destinations and exit"
  echo "  --dry-run         resolve and report, write nothing"
  echo ""
  echo "Back-compat: --target user and --target project still mean Claude Code,"
  echo "user-global and project-local respectively."
}

while [ $# -gt 0 ]; do
  case "$1" in
    # Back-compat with the two-mode flag this script used to have.
    --target=user)    TARGETS="claude"; SCOPE="user"; shift ;;
    --target=project) TARGETS="claude"; SCOPE="project"; shift ;;
    --target=*)       TARGETS="${1#--target=}"; shift ;;
    --target)
      shift
      case "$1" in
        user)    TARGETS="claude"; SCOPE="user" ;;
        project) TARGETS="claude"; SCOPE="project" ;;
        *)       TARGETS="$1" ;;
      esac
      shift
      ;;
    --scope=*)  SCOPE="${1#--scope=}"; shift ;;
    --scope)    shift; SCOPE="$1"; shift ;;
    --list)     DRY_RUN=2; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --help|-h)  usage; exit 0 ;;
    *) shift ;;
  esac
done

[ -n "$TARGETS" ] || TARGETS="auto"
[ -n "$SCOPE" ] || SCOPE="user"

if [ "$SCOPE" != "user" ] && [ "$SCOPE" != "project" ]; then
  echo "! Unknown --scope '$SCOPE' (expected user or project)." >&2
  exit 1
fi

# ── Resolve the target list ──────────────────────────────────────────

expand_targets() {
  case "$TARGETS" in
    all)  echo "$ALL_TARGETS" ;;
    auto)
      found=""
      for t in $ALL_TARGETS; do
        detect="$(target_paths "$t" | cut -d'|' -f3)"
        [ -n "$detect" ] || continue
        [ -d "$detect" ] || continue
        # Project-only agents (cursor, agents) are skipped by autodetect
        # under the default user scope: the piped one-liner is usually run
        # from whatever directory the terminal happened to be in, and
        # writing skills into that directory is not what anyone asked for.
        # `--scope project` or naming the target explicitly still installs.
        if [ "$SCOPE" = "user" ] && [ -z "$(target_paths "$t" | cut -d'|' -f1)" ]; then
          continue
        fi
        found="$found $t"
      done
      # Nothing detected: the machine may have no agent installed yet, or
      # this may be a CI box. Claude Code is the safe default — it was the
      # only destination this script ever had.
      [ -n "$found" ] || found="claude"
      echo "$found"
      ;;
    *) echo "$TARGETS" | tr ',' ' ' ;;
  esac
}

RESOLVED=""
for t in $(expand_targets); do
  paths="$(target_paths "$t")"
  if [ -z "$paths" ]; then
    echo "! Unknown target '$t' (expected one of: $ALL_TARGETS)." >&2
    exit 1
  fi
  if [ "$SCOPE" = "user" ]; then
    dir="$(echo "$paths" | cut -d'|' -f1)"
    # Cursor and the vendor-neutral .agents/ convention have no
    # user-global directory. Under an explicit --target they fall back to
    # the project path (with a note) rather than being silently dropped;
    # under --target auto/all they are simply project-scoped.
    if [ -z "$dir" ]; then
      dir="$(echo "$paths" | cut -d'|' -f2)"
      echo "   note: $t has no user-global skills directory — using $dir"
    fi
  else
    dir="$(echo "$paths" | cut -d'|' -f2)"
  fi
  RESOLVED="$RESOLVED$t=$dir
"
done

if [ "$DRY_RUN" = "2" ]; then
  echo "$RESOLVED" | while IFS='=' read -r name dir; do
    [ -n "$name" ] || continue
    echo "$name -> $dir"
  done
  exit 0
fi

# ── Fetch ────────────────────────────────────────────────────────────

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

BUNDLE_VERSION="$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)"

# ── Install ──────────────────────────────────────────────────────────

install_into() {
  dir="$1"
  if [ "$DRY_RUN" = "1" ]; then
    echo "-> would install to $dir"
    return 0
  fi
  mkdir -p "$dir"
  echo "-> Installing to $dir"
  count=0
  for skill in "$SRC"/*/; do
    [ -d "$skill" ] || continue
    name="$(basename "$skill")"
    rm -rf "$dir/$name"
    cp -r "$skill" "$dir/$name"
    count=$((count + 1))
    echo "   + $name"
  done
  # Bundle VERSION + CHANGELOG live alongside so the staleness check has
  # a single number to compare against. Spelled as `if` rather than
  # `[ … ] && cp …`: under `set -e` a trailing false test is the
  # function's exit status, and the installer would abort on a tarball
  # that simply had no CHANGELOG.
  if [ -f "$SRC/VERSION" ]; then cp "$SRC/VERSION" "$dir/VERSION.brain"; fi
  if [ -f "$SRC/CHANGELOG.md" ]; then cp "$SRC/CHANGELOG.md" "$dir/CHANGELOG.brain.md"; fi
  echo "   $count skills (bundle $BUNDLE_VERSION)"
  return 0
}

TOTAL=0
echo "$RESOLVED" | {
  while IFS='=' read -r name dir; do
    [ -n "$name" ] || continue
    install_into "$dir"
    TOTAL=$((TOTAL + 1))
  done
  echo ""
  echo "Installed brain skills $BUNDLE_VERSION into $TOTAL location(s)."
}

echo ""
echo "Next: point your agent at brain over MCP."
echo "      Claude Code:  claude mcp add --transport http brain https://brain.inite.ai/mcp \\"
echo "                      --header \"Authorization: Bearer \$BRAIN_API_KEY\""
echo "      Everything else: https://brain.inite.ai/en/docs/mcp/setup"
