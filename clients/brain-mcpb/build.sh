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
cp -R "$shim/src" "$shim/package.json" "$shim/tsconfig.json" "$work/build/"
(cd "$work/build" && npm install --ignore-scripts --no-audit --no-fund >/dev/null && npm run build >/dev/null)

cp "$here/manifest.json" "$here/README.md" "$here/icon.png" "$work/bundle/"
cp "$work/build"/dist/*.js "$work/build/package.json" "$work/bundle/server/"
(cd "$work/bundle/server" && npm install --omit=dev --ignore-scripts --no-package-lock --no-audit --no-fund >/dev/null)

mkdir -p "$here/dist"
npx -y @anthropic-ai/mcpb@2.1.2 validate "$work/bundle/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$work/bundle" "$here/dist/inite-brain.mcpb" | tail -4
