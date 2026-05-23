#!/usr/bin/env bash
# Build + push + ssh-apply for the brain-landing image.
# Mirrors initeaicom/deploy.sh — flags match.
set -euo pipefail

IMAGE="${IMAGE:-inite/brain-landing:latest}"
HOST="${DEPLOY_HOST:-inite-temporal}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/srv/brain-landing}"

# Pack the skills tarball from the parent repo so it lands in public/
# before the docker build copies the directory in.
( cd .. && pnpm skills:pack )

docker buildx build \
  --platform=linux/amd64 \
  --build-arg NEXT_PUBLIC_BRAIN_API_URL="${NEXT_PUBLIC_BRAIN_API_URL:-https://brain.inite.ai}" \
  -t "$IMAGE" \
  --push \
  .

ssh "$HOST" "cd $REMOTE_DIR && docker compose pull && docker compose up -d"
echo "✓ deployed $IMAGE to $HOST"
