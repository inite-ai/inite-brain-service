# Next-session command — finish the max-params=3 program + audit remainder

> Self-contained brief. **Open this first.** Picks up after the 2026-06-28
> session, which merged the typecheck gate + layer-purity cleanups + part 1/3
> of the `max-params=3` program. This file is the command to finish EVERYTHING
> the user asked for: "делай всю" — do the whole program.

## Pre-flight (do before anything)

1. `git -C ~/Documents/inite-brain-service checkout main && git pull --ff-only`
   then `git log --oneline -12`. `main` was at the `#49` merge
   (`refactor(*): objectify functions with >3 params … (1/3)`) when this was
   written; confirm what's newer.
2. Read auto-memory **`maxparams_program.md`** (the resumable plan + per-class
   dep counts) and **`audit_next_session.md`** first. This brief assumes them.

## What's already done (context — do NOT redo)

Merged to `main` + deployed this session:
- **#44** — the typecheck gate: `tsconfig.spec.json` + a "Typecheck (src + tests)"
  step in `build-test`. Before this, `tsc` excluded `test/`, so a type error in a
  spec only surfaced when ts-jest happened to run it. `pnpm typecheck` now covers
  src + tests. **This gate catches test-construction breakage at PR time — expect
  it to flag every spec that builds a class whose constructor you change.**
- **#45** — fixed SDK type drift in 5 real-e2e specs (surfaced by #44).
- **#46 / #47 / #48** — layer purity (`import/no-restricted-paths`): `health` /
  `admin-infra` / `admin` controllers no longer import `src/db` directly (logic
  moved into `HealthService` / `AdminInfraService` / `AdminService`).
- **#48** — killed the positional-`undef` soup in admin contract specs:
  `test/helpers/admin-controllers.ts` exposes `makeAdminController({...})` /
  `makeAdminInfraController({...})` with **named** deps. **Never write
  positional-`undef` controller construction again — extend these helpers (or
  add a sibling helper) for any new controller.**
- **#49 (max-params 1/3)** — 69 non-constructor functions with >3 params now take
  a single options object, **destructured in the signature so the body is
  unchanged** (low-risk). Pattern reference: `scoreRows` in
  `src/search/internals/scoring.ts`.

## Established workflow (use verbatim — it works)

1. Branch off fresh `main`: `git checkout main && git pull && git checkout -b <topic>`.
2. Small commits, push early.
3. PR with a **conventional-commit title** (the check named `lint` is the
   semantic-PR-title check; the eslint run is inside `build-test`).
4. The **only required status check is `build-test`**. `summarize` often 403s —
   ignore. `docker` not required.
5. The user said **"делай всю"** and authorised **auto-merge of green PRs in this
   program**: `gh pr merge <n> --squash --admin --delete-branch` once
   `build-test` is green. Merge = prod deploy (`deploy-brain.yml`). The admin
   controllers/services share `src/admin/admin.module.ts`, so **admin PRs
   conflict with each other — merge them one at a time** (branch the next off
   updated `main`).
6. After merge: `git checkout main && git pull --ff-only`.

### Acceptance bar (every PR)
- `pnpm exec tsc --noEmit` clean · **`pnpm typecheck` clean** (the new src+tests
  gate — run this, it catches spec breakage) · `pnpm lint` clean ·
  `pnpm test` green (700 unit at the start) · `pnpm test:e2e` green (128).
- `pnpm test -- --testPathPattern=…` does NOT work (double `--`); use
  `pnpm exec jest --config ./test/jest-unit.json <pattern>`.

---

## THE WORK

### Part 2/3 — split the 18 god-classes to ≤3 DI deps  (the big epic)

The user **explicitly rejected** both exempting constructors and folding deps
into one object. The fix is **real responsibility-splitting**: each class with
>3 injected deps becomes multiple focused classes, each with ≤3.

**Order: smallest dep-count first** (cheap consolidations build momentum and the
pattern), hardest orchestrators last. One class = one PR; verify tsc+typecheck+
lint+unit+e2e each. Dep counts measured 2026-06-28 (grep-rough — re-confirm by
reading the constructor):

| deps | class | suggested split |
|---|---|---|
| 3 | `auth/api-key.guard.ts` | already at 3 — confirm it's not actually >3 after re-count; likely no-op |
| 4 | `ai/embedder/reindex-embeddings.service.ts` | consolidate 2 cohesive deps into a small helper service → 3 |
| 4 | `entities/entities.service.ts` | already had pure logic pulled to `entity-read.helpers.ts`; group remaining 4th dep or split read vs forget |
| 4 | `jobs/lease-manager.service.ts` | consolidate → 3 |
| 6 | `multi-hop/multi-hop.service.ts` | extract the planner/executor collaborators behind a facade |
| 7 | `admin/admin-infra.controller.ts` | push remaining deps into `AdminInfraService` (started in #47) |
| 7 | `dreams/dedup.service.ts` | split the LLM-judge path from the DB path |
| 9 | `admin/admin-demo.controller.ts` | **also finishes C-series**: split into focused sub-controllers / push queries into a demo service |
| 9 | `ingest/ingest-predictor.service.ts` | extract scoring/lookup collaborators |
| 10 | `audit/changefeed-consumer.service.ts` | split consume-loop vs redaction vs metrics |
| 11 | `compaction/compaction.service.ts` | split per-strategy services |
| 13 | `jobs/worker-loop.service.ts` | extract claim/lease/handler-dispatch collaborators |
| 14 | `ai/extractor.service.ts` | split NER / predicate / synth passes (internals already exist under `extractor-internals/`) |
| 15 | `admin/scenario-runner.service.ts` | split per-phase runners |
| 16 | `admin/chat-router.service.ts` | split intent vs cache vs collapse |
| 16 | `ai/calibration/calibration-refit.service.ts` | split fit vs persist vs schedule |
| 16 | `search/search.service.ts` | **hardest** — it's the stage orchestrator; the stage modules already live in `search/internals/`. Group them behind a small number of stage-facade services injected into the orchestrator (retrieval-facade / rerank-facade / assemble-facade), each ≤3. |
| 22 | `ingest/ingest.service.ts` | **hardest** — already has `ingest-utils.ts` + `FactWriter`-style helpers pulled; split write-path vs mention-path vs link-path into sibling services injected by a thin orchestrator |

Re-confirm each count by reading the constructor (the awk over-counts). Some
"4-dep" ones may already be at 3 after the earlier extractions.

**Pattern for a split:** create sibling `@Injectable()` services that own a
cohesive slice (+ their own ≤3 deps), register them in the owning `*.module.ts`,
have the original class inject the new services instead of the raw collaborators.
The typecheck gate will flag every spec that constructs the changed class —
update those specs (use / extend the named-dep test helpers, never positional
`undef`).

### Part 3/3 — the gate flip  (do LAST, only when all 95 are clean)

1. **7 route handlers** with `@Query` / `@Param` / `@Body`-decorated params
   (in `admin-jobs` / `admin-ops` / `admin` / `communities` / `entities`
   controllers) CANNOT be objectified — that breaks HTTP param binding. Either
   add a per-line `// eslint-disable-next-line max-params -- decorated route
   handler` with a one-line justification, OR add an eslint override that
   exempts methods whose params carry parameter decorators. Find them by
   temporarily setting the gate to 3 and running eslint (skip `constructor(`
   lines; what remains after part 2 are these handlers).
2. **Flip the gate:** in `eslint.config.mjs`, `'max-params': ['error', 8]` →
   `['error', 3]`. Run `pnpm lint` — must be clean. If anything still trips,
   it's an un-split class (part 2) or an un-exempted handler. Update the config
   comment (the `// max-params (8)` doc block) to say 3.

To enumerate remaining violators at any point:
```
cp eslint.config.mjs /tmp/e.bak
sed -i '' "s/'max-params': \['error', 8\]/'max-params': ['error', 3]/" eslint.config.mjs
pnpm exec eslint "src/**/*.ts" -f json > /tmp/mp.json 2>/dev/null   # parse ruleId max-params; skip constructor( lines for funcs
cp /tmp/e.bak eslint.config.mjs                                      # RESTORE (don't leave 3 until the end)
```

### Other audit remainder (from `audit_next_session.md` — fold in when convenient)
- **D-complexity (3):** `multi-hop.run` / `job-run.list` / `dreams.runForTenantInner`
  carry `// eslint-disable complexity`. Refactor by extraction **only if it
  genuinely improves** (these are orchestration; don't churn for cosmetics).
- **B — the 2 `it.skip`** in `test/concurrency.real-e2e-spec.ts`: documented
  testcontainer-scale limits (rocksdb write-lock fairness / migration-apply
  budget), alt-covered by sota/upsert e2e. Real fix = split namespace-level vs
  database-level migrations so cold-start applies in parallel (research stream
  A2). Risky; needs real-DB verification.
- **LoCoMo** full run + publish (paid, ~$110, 2–4h) — the one item from the
  older `mcp-and-memory.md` roadmap.

## Gotchas (hard-won)
- **Gate flip is LAST.** Setting `max-params:3` before all 95 are clean red-lines
  CI on everything at once.
- **The typecheck gate (#44) fails the build on test-construction drift** — every
  constructor signature change cascades into the contract specs. That's the gate
  working; fix the specs via the named-dep helpers.
- **DI constructors: split, don't exempt or deps-object** (user's explicit call).
- **`tsconfig.spec.json` excludes `brain` + `dreams` real-e2e specs** (they import
  the `@inite/knowledge` SDK from sibling `../inite-shared`, not checked out in
  the self-contained `build-test`). Don't try to include them there.
- Frozen eval golden lives at `test/eval/golden-baseline.json`; the eval test cap
  is 30 min (`1_800_000`). Don't reintroduce the 20-min cap.

## Files to read first
- `test/helpers/admin-controllers.ts` (named-dep test pattern).
- `src/search/internals/scoring.ts` (`scoreRows`) — the options-object pattern.
- `src/admin/admin-infra.service.ts` + `src/common/health.service.ts` — the
  layer-purity extraction pattern.
- `eslint.config.mjs` (`sizeGates`, the `max-params` rule + its doc block).
- `tsconfig.spec.json` (the src+tests typecheck config).
