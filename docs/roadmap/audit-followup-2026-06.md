# Audit follow-up — next session brief

> Self-contained brief. Open this file first. Picks up after the 2026-06-25/26
> audit, which landed six waves to `main` (#27 security+correctness, #30 ops,
> #31 governance, #32 ci-stability, #33 strict-ts, #34 docs). This file is the
> remaining backlog: larger, refactor-scale work that was deliberately left for
> a focused session rather than done as quick fixes.

## Who is reading this

The assistant continuing the brain audit. Before starting:

- `git -C ~/Documents/inite-brain-service pull` and `git log --oneline -8` —
  `main` was at `888a911` when this was written. Confirm what's newer on top.
- Read the auto-memory `audit_2026-06-25.md` first — it has the full wave list,
  the **debunked false findings** (do NOT re-investigate those), and the
  hard-won gotchas. This brief assumes that context.

## Established workflow (use it verbatim — it works)

1. Branch off fresh `main`: `git checkout main && git pull && git checkout -b audit/<topic>`.
2. **Commit small and push early.** Each logical change → its own commit → push
   immediately. (During the last session a parallel session twice reset shared
   branches; pushed commits survive, uncommitted work is at risk.)
3. PR with a **conventional-commit title** (`feat:`/`fix:`/`chore:`/`test:`/`docs:`)
   — the check literally named `lint` is `amannn/action-semantic-pull-request`
   and rejects non-conventional titles. The eslint run is inside `build-test`.
4. The **only required status check is `build-test`**
   (`gh api repos/inite-ai/inite-brain-service/branches/main/protection`). `docker`
   and `summarize` are NOT required; `summarize` (AI PR summary via GitHub Models)
   often 403s — ignore it.
5. Branch protection requires 1 review. The owner has been **admin-squash-merging**
   each PR: `gh pr merge <n> --squash --admin --delete-branch`. Confirm before
   doing so — merging `main` triggers the prod deploy (`deploy-brain.yml` on push).
6. After merge: `git checkout main && git merge --ff-only origin/main` and delete
   the local branch.

### Acceptance bar (every PR)
- `pnpm exec tsc --noEmit` clean · `pnpm lint` clean · `pnpm test` green (currently
  642 unit) · `pnpm test:e2e` green (128 in-process e2e, testcontainers + stubs).
- `tsc` only checks `src/` (`exclude: ["test"]`), but **ts-jest compiles test files
  under the now-strict tsconfig** — run the suites, don't trust tsc alone.
- New DB-touching feature → a real e2e. New MCP tool → entry in
  `test/mcp-tools.unit-spec.ts` + the `HEALTH_TOOLS` list + the scope matrix in
  `skills/brain-mcp-setup/SKILL.md` (and the tool count in docs — see #6 below).

## The work, prioritised

### 1. Decompose a god-service, then unit-test the extracted logic  (biggest value)

The three largest services have **no unit spec** and are only covered by slow
live-DB e2e: `src/ingest/ingest.service.ts` (993), `src/db/surreal.service.ts`
(856), `src/entities/entities.service.ts` (583).

**Do NOT just bolt mocking-heavy unit specs onto them** — they're DB-orchestration
inside `withCompany`/`withScopedCompany` closures, so mock-the-db tests mostly
assert query strings (low ROel) and the e2e already covers the happy path. The
valuable move is **extract the pure logic, then unit-test that**:

- `ingest.service.ts`: extract a `FactWriter` (the `resolveFactCall` + locale +
  the HyPE post-INSERT UPDATE block, which is copy-pasted at ~`:199-210` and
  `:891-902`), an entity-upsert helper, and PII/key utils (`redactPii`,
  `externalRefKey`, `idTailOf`). Unit-test the writer + utils in isolation.
- `entities.service.ts`: extract `normalizeEntityId` (`:573`, already pure) and the
  PII-gating / asOf row-filter predicates (the `.filter()` callbacks at ~`:132`,
  `:264`) into testable pure functions; unit-test them.
- `surreal.service.ts`: the transaction/pool/retry logic — at minimum a
  contract-level unit spec for `retryOnUniqueViolation` and the conflict-error
  classification heuristic (`:714-723`).

**Acceptance:** each extraction is behaviour-preserving (e2e still green), and the
extracted pure helpers get a `*.unit-spec.ts` with real assertions. Land one
service per PR so review stays tractable.

### 2. `mcp.service.ts` decomposition  (unblocks the next MCP tool)

908 raw lines. Lint currently PASSES (the `max-lines` 800 rule uses
`skipComments`/`skipBlankLines`, and the huge tool-description string literals are
mostly comments), so it's **not broken — just full**. The next tool addition will
push it over. Extract by scope into sibling files, following the **already-proven
`src/mcp/community-tools.ts` pattern** (a `registerXxxTools(server, companyId, deps)`
free function): `read-tools.ts`, `write-tools.ts`, `procedural-tools.ts`. Keep
`HEALTH_TOOLS` + `buildServer` in `mcp.service.ts`.

**Acceptance:** `test/mcp-tools.unit-spec.ts` still green (it asserts tool names per
scope), lint clean, and adding a dummy tool no longer trips `max-lines`.

### 3. Freeze the eval golden baseline + stop the nightly ratchet

`#31` already added a hard absolute overall floor (recall@1 0.85 / recall@3 0.93 /
MRR 0.88) that anchors against erosion. The remaining gap: the nightly baseline in
`scripts/eval-baseline-diff.ts` is cache-restored and self-promoted on every green
run (`ci.yml`), so a slow 1pp/night drift ratchets the comparison baseline down.

- Commit a **frozen golden** `eval-baseline.json` (run `pnpm test:eval` with
  `BRAIN_EVAL_REPORT_OUT=...`; the 2026-06-25 measured baseline is recall@1 0.95 /
  recall@3 0.99 / MRR 0.97, n=262, OpenAI embedder, `THROTTLE_DISABLED=1`).
- Diff against the committed golden, not the cache-promoted one.
- **Gotcha:** the quality eval needs `THROTTLE_DISABLED=1` OR the
  `THROTTLE_EXPENSIVE_*` lift (now in `test/spawn/spawn-service.ts`) — search sits
  in the *expensive* throttle tier; without it the run 429s on `/v1/search`.
- Cost: ~$ + ~17 min wall per full run on real OpenAI. Keys are already in `.env`.

### 4. Smaller, lower-priority items
- **Hard `/ready` deploy gate.** `#30` added a warning-only `/ready` probe. A hard
  gate was deliberately skipped: bge-m3 (the prod embedder, `EMBEDDER_PROVIDER=bge-m3`)
  ONNX warmup time is unbounded on a cold image and could flake deploys. If you make
  it hard, give it a generous window AND keep the Docker container healthcheck on
  `/health` (liveness) so warmup doesn't get the container killed.
- **Docker base digest-pin.** `node:22-slim` is a floating tag. Pin by digest —
  but look up the real digest (`docker buildx imagetools inspect node:22-slim`);
  never guess one (breaks the build). Manual step.
- **Full LoCoMo run + publish** (the one genuinely-open item from the *previous*
  roadmap, `mcp-and-memory.md` Phase 5.2): `--agent claude-mcp`, ~$110, 2–4h. Then
  README "latest gate run" row + `docs/locomo-baseline.md`.

## Gotchas / lessons from the 2026-06-25 session

1. **Verify agent findings by hand before fixing.** Last session ~half the
   "scary" findings were false (dedupKey collapse, resolve_fact atomicity,
   prod-gate demo/admin, MCP /health leak). The memory lists them — don't redo.
2. **`tsc` excludes `test/`** but ts-jest compiles tests under the strict flags
   now enabled. A green `tsc` does not mean the test suites compile.
3. **The communities e2e flake is FIXED** (`#32`, deterministic fact order). Root
   cause was non-deterministic `ORDER BY` → varying summary text → varying stub
   embedding → cosine sign flip under `minSimilarity:0`. If you touch community
   summarisation, keep the projection fully ordered.
4. **StubEmbedder (`test/test-doubles.ts`) is non-semantic** (sha256 hash). Don't
   make it non-negative globally — that breaks `procedural-memory` / `sota` e2e
   which rely on the `~0` cosine between unrelated texts. (Tried it, reverted it.)
5. **Self-hosting / parallel sessions share one working tree.** Commit + push fast.
6. **Live MCP surface = 21 tools** (15 read / 20 +write / 21 +admin) + 2 resources.
   Keep `HEALTH_TOOLS`, the skill scope matrix, and the doc counts in sync when you
   add a tool (last session they had drifted to 18/14/13/10).

## Files to read first
- `src/mcp/mcp.service.ts` + `src/mcp/community-tools.ts` — decomposition target + pattern.
- `src/ingest/ingest.service.ts`, `src/entities/entities.service.ts`,
  `src/db/surreal.service.ts` — extraction targets.
- `test/eval/runner/aggregator.ts` (floors), `scripts/eval-baseline-diff.ts`,
  `.github/workflows/ci.yml` (baseline cache) — governance.
- `test/spawn/spawn-service.ts` — how the eval harness boots (throttle, keys, model pin).
