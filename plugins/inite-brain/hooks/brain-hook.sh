#!/bin/sh
# Dispatcher for the brain lifecycle hooks.
#
# A hook that fails is a hook that makes the agent worse, so every exit
# path here is 0 and silent: no key configured, no node on PATH, or a
# brain that is down must never cost the user a session. The real work
# is in brain-hook.mjs — JSONL transcripts and JSON hook payloads are
# not POSIX sh problems.
#
# Usage: brain-hook.sh recall | capture
set -e

[ -n "${CLAUDE_PLUGIN_OPTION_API_KEY:-}" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

exec node "$(dirname "$0")/brain-hook.mjs" "$@"
