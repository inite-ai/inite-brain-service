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

FROM node:22-slim AS builder

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
FROM node:22-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
# Runtime stage: same allowlist semantics as the builder — the prod
# install still needs sharp + onnxruntime-node native binaries.
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/main.js"]
