# node:22-slim (Debian-based, glibc) — NOT alpine.
#
# Why: `onnxruntime-node` (transitive dep of @xenova/transformers,
# used by LocalNerService + IntentClassifierService) ships precompiled
# linux/x64 binaries that link against the glibc dynamic linker
# `ld-linux-x86-64.so.2`. Alpine's musl libc does not provide it, so
# the model warmup throws on prod boot:
#
#   "Error loading shared library ld-linux-x86-64.so.2: No such file
#    or directory (needed by .../libonnxruntime.so.1.14.0)"
#
# The services degrade gracefully (extractor falls back to LLM-only
# NER, router to punctuation-only intent), but we lose the local
# pre-pass speed-up. Switching to Debian slim is the simplest fix —
# `apk add gcompat libc6-compat` is unreliable for native ABIs this
# specific.
#
# Pinned by digest, not the floating `:22-slim` tag, so a base-image
# republish can't silently change the build under us — reproducible
# images + an auditable bump. Refresh both FROMs together with the new
# manifest-list digest from:
#   docker buildx imagetools inspect node:22-slim   # → Digest:
# (use the top-level multi-arch manifest digest, which resolves per-arch).

FROM node:22-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
# NO --ignore-scripts: native deps (sharp, onnxruntime-node) need
# their postinstall to materialise platform-specific .node binaries.
# pnpm's `onlyBuiltDependencies` allowlist in package.json restricts
# which packages may actually run scripts, so we keep the security
# posture while letting the natives compile.
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json nest-cli.json ./
COPY src ./src
# Eval types/scenarios/fixtures used by the admin scenario runner now
# live under src/eval (moved from test/eval to honour the
# production-code-must-not-import-from-test/ rule). They get included
# via COPY src ./src — no extra COPY needed.

RUN pnpm build

# ── Runtime ──────────────────────────────────────────────────────────────
# Same digest pin as the builder stage above (keep them in lockstep).
FROM node:22-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4

# wget is preinstalled on node:22-alpine but NOT on -slim (Debian).
# The deploy workflow's docker-compose healthcheck shells `wget -qO-
# http://localhost:3000/health` from inside the container, so without
# it the container-level health probe never goes green and the deploy
# job's "internal health probe" wait loop times out even though the
# Nest app booted cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
# Runtime stage: same allowlist semantics as the builder — the prod
# install still needs sharp + onnxruntime-node native binaries.
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

# Run as the unprivileged `node` user (uid 1000, ships with the official
# image) instead of root. node_modules / dist stay root-owned but are
# world-readable, which is all the runtime needs. The two writable paths:
#   - the @xenova/transformers / onnxruntime model cache (lazy download
#     on warmup) — pointed at /app/.cache, owned by node.
#   - the baselines bind-mount, which the deploy workflow already chowns
#     to 1000:1000 (matching this user).
RUN mkdir -p /app/.cache && chown node:node /app/.cache
ENV TRANSFORMERS_CACHE=/app/.cache \
    HF_HOME=/app/.cache \
    XDG_CACHE_HOME=/app/.cache

ENV NODE_ENV=production
EXPOSE 3000

USER node

CMD ["node", "dist/main.js"]
