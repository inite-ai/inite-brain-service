<!--
Thanks for contributing to INITE Brain! Keep the description focused on the
*why* — the diff already shows the *what*. AGENTS.md has the zones, gates and
conventions; CONTRIBUTING.md has the bars. The PR title must be a
Conventional Commit (feat: / fix: / docs: …, `!` for breaking).
-->

## In plain words

<!-- Two or three sentences a non-engineer can follow: what changes for whom, and why. -->

## What & why

<!-- What does this change, and what problem does it solve? Link any issue: Closes #123 -->

## How

<!-- Notable implementation choices, trade-offs, or anything a reviewer should look at first. -->

## Zone

<!-- See the Zones table in AGENTS.md. Red needs a maintainer-approved issue first. -->

- [ ] 🟢 green
- [ ] 🟡 yellow — what I touched and why:
- [ ] 🔴 red — approved design: #

## Gates

- [ ] Ran locally: `pnpm lint:ci` · `pnpm format:check` · `pnpm typecheck` · `pnpm build` · `pnpm test` · `pnpm test:socket`
- [ ] E2E (`pnpm test:e2e` / `pnpm test:e2e:jobs`) ran locally, or left to CI
- [ ] `brain-landing/` touched → its lint / typecheck / test / build ran
- [ ] CI green

## Checklist

- [ ] Tests added or updated (name them):
- [ ] Retrieval / ingest touched → which eval battery measures it, and the result (paid evals only with a maintainer's OK)
- [ ] Schema changes ship as **new numbered migrations** in `src/db/migrations/` (never edit an old one)
- [ ] Generated files regenerated, not hand-edited (`pnpm openapi:build`, `pnpm plugin:sync`, …)
- [ ] Docs updated if behavior or the API changed
- [ ] Commit messages explain the _why_

## AI assistance

<!-- Disclosure, not judgment. -->

- [ ] No
- [ ] Yes — agent / model:

## Screenshots / output

<!-- For UI or eval changes, paste a screenshot or the relevant output. Delete if N/A. -->
