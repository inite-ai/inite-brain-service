# ────────────────────────────────────────────────────────────────
# brain-landing — Next.js 16 + Tailwind 4 + MDX
#
# Build context expects `public/skills.tar.gz` + `public/install.sh`
# to already be in place. Run `pnpm skills:pack` from the parent
# inite-brain-service repo before `docker build`, or wire it into
# CI before the build-push step.
# ────────────────────────────────────────────────────────────────

FROM node:22-alpine AS builder
WORKDIR /app

# pnpm via corepack — same channel the rest of the repo uses.
RUN corepack enable && corepack prepare pnpm@10 --activate

# Deps first for cache hits. `--ignore-workspace` makes the build
# standalone — pnpm-lock.yaml in this folder is the source of truth,
# the enclosing /Users/.../Documents/pnpm-workspace.yaml is ignored.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace

# Then sources.
COPY tsconfig.json next.config.js postcss.config.js tailwind.config.js next-env.d.ts mdx-components.tsx ./
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY hooks ./hooks
COPY locales ./locales
COPY public ./public
COPY middleware.ts ./middleware.ts

ARG NEXT_PUBLIC_BRAIN_API_URL=https://brain.inite.ai
ENV NEXT_PUBLIC_BRAIN_API_URL=$NEXT_PUBLIC_BRAIN_API_URL

RUN pnpm build

# ── Runtime image ────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate

# Only what's needed at runtime.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace --prod

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.js ./next.config.js
COPY --from=builder /app/mdx-components.tsx ./mdx-components.tsx

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 && chown -R nextjs:nodejs /app
USER nextjs

EXPOSE 3030
ENV NODE_ENV=production
ENV PORT=3030
ENV HOSTNAME=0.0.0.0

# Invoke next directly — `pnpm start` runs runDepsStatusCheck on every
# boot, which in pnpm 11.6 tries to purge node_modules without a TTY
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) and aborts. The runtime
# image's deps are already frozen from the install step above; no
# integrity re-check is needed.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3030"]
