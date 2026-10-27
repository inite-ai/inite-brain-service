#!/usr/bin/env bash
# Runs once when the devcontainer is created. Mirrors CI's install
# (.github/workflows/ci.yml: pnpm install --frozen-lockfile --ignore-workspace).
set -euo pipefail

# pnpm at the exact version package.json's "packageManager" pins.
sudo corepack enable
corepack install

pnpm install --frozen-lockfile --ignore-workspace

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — set OPENAI_API_KEY for ingest/search."
fi

cat <<'MSG'

INITE Brain dev container ready.
  pnpm start:dev        API on :3000 (SurrealDB already on :8000)
  pnpm test             unit tests (no DB, no keys)
  AGENTS.md             commands, zones and the idea -> PR loop
  /contribute           in Claude Code: idea -> spec -> code -> PR
Landing app: cd brain-landing && pnpm install --frozen-lockfile && pnpm dev
MSG
