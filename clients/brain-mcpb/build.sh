#!/usr/bin/env bash
# Packs dist/inite-brain.mcpb: the @inite/brain-mcp shim with its runtime
# dependencies, under this folder's manifest. Desktop runs it on its own
# bundled Node, so the bundle carries node_modules and needs no install.
# Everything is built in a temp folder: the shim's own folder is left
# untouched (a node_modules there would shadow the root SDK copy in tests).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
shim="$here/../brain-mcp"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/build" "$work/bundle/server"
# Installs come from the lockfile beside this script (generated from the
# shim's package.json), never from a fresh resolve: the bundle ships its
# node_modules, so what it contains must be pinned. A shim dependency
# change makes `npm ci` refuse until the lock is regenerated:
#   (cp ../brain-mcp/package.json /tmp/x/ && cd /tmp/x && npm install --package-lock-only)
cp -R "$shim/src" "$shim/package.json" "$shim/tsconfig.json" "$work/build/"
cp "$here/package-lock.json" "$work/build/"
(cd "$work/build" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm run build >/dev/null)

cp "$here/manifest.json" "$here/README.md" "$here/icon.png" "$work/bundle/"
cp "$work/build"/dist/*.js "$work/build/package.json" "$here/package-lock.json" "$work/bundle/server/"
(cd "$work/bundle/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm package-lock.json)

mkdir -p "$here/dist"
npx -y @anthropic-ai/mcpb@2.1.2 validate "$work/bundle/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$work/bundle" "$here/dist/inite-brain.mcpb" | tail -4
