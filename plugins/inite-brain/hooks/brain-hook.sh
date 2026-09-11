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

if [ -z "${CLAUDE_PLUGIN_OPTION_API_KEY:-}" ] || ! command -v node >/dev/null 2>&1; then
  # Drain the payload before leaving. The harness writes the event JSON
  # to our stdin; exiting without reading it closes the pipe under the
  # writer, which sees EPIPE — an error raised by the very hook whose
  # whole contract is to be invisible when it has nothing to do.
  cat >/dev/null 2>&1 || true
  exit 0
fi

exec node "$(dirname "$0")/brain-hook.mjs" "$@"
