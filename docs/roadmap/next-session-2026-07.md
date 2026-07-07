# Next-session command — after the code-memory domain (2026-07-07)

> Self-contained brief. **Open this first.** Picks up after the session that
> (a) finished the `max-params=3` program and (b) built the entire **code-memory
> domain + Domain Pack system** end to end. Everything below is either "context,
> do not redo" or a genuinely-open track that needs a product/data decision, not
> just more code.

## Pre-flight

1. `git -C ~/Documents/inite-brain-service checkout main && git pull --ff-only`
   then `git log --oneline -15`. Main was at `#91` when this was written.
2. Read auto-memory **`code_memory_domain.md`** (full domain history + gotchas)
   and **`maxparams_program.md`**. This brief assumes them.
3. Acceptance bar for every PR (unchanged): `pnpm exec tsc --noEmit` ·
   `pnpm typecheck` · `pnpm lint` (max-params=3, complexity=25) · `pnpm test` ·
   `pnpm test:e2e` · `pnpm test:e2e:jobs`. Current baseline: **823 unit / 160
   e2e / 9 jobs** (was 772/146/9 before `#93`/`#94`/`#96`/`#101`/`#103`).
4. Workflow (works, use verbatim): branch off main → small commits → PR with a
   conventional title → wait for `build-test` green (only required check;
   `summarize` 403 is ignored) → `gh pr merge <n> --squash --admin
   --delete-branch` (merge = prod deploy) → `git pull --ff-only`.
   **Ask the user before the first admin-merge of a session** unless they've said
   "делай/делай все" for the work in hand.

## Shipped this session — DO NOT redo

- **max-params=3 program** — `#67–#70`: split the last 3 god-classes
  (ingest / scenario-runner / chat-router) + flipped the eslint gate 8→3 (7
  decorated route handlers per-line-exempted).
- **Code-memory domain** — remember the non-derivable engineering "why" of a
  codebase (decisions / rationale / invariants / gotchas), NOT a code index:
  - `#71` Phase 0 — `record_decision` / `why` MCP tools + code predicates.
  - `#72` Phase 1 — hybrid client-side capture (`pnpm capture:decisions`):
    Layer-1 heuristic classifier (BiLSTM seam) → Layer-2 LLM extract → facts to
    `/v1/ingest/fact`; raw code never leaves the machine.
  - `#86` Phase 2 — drift-resistant symbol anchors `path#Symbol.method` via the
    TS compiler API + grounding.
  - `#89` Phase 2b — anchor re-validation sweep (`pnpm code-memory:validate-anchors`):
    reanchor renames / invalidate deletes. `/v1/admin/code-memory/anchors`.
  - `#87` Phase 3 — eval gate (exact `why` recall + invariant surfacing).
  - `#88` Phase 3b — `CodeMemorySearchService` + `recall_decisions` MCP tool
    (semantic recall; the general entity search returns 0 for code anchors).
- **Domain Pack system** — the ontology as a versioned, pluggable, community
  artifact (docs/domain-packs.md):
  - `#73` standard + namespacing (`packId__localId`) + merge loader; code-memory
    became pack #1 (`code_memory`).
  - `#85` runtime per-tenant install/uninstall (`/v1/admin/packs`, migration 0040).
  - `#90` distribution — JSON-manifest install (`pnpm pack:install`) + integrity
    checksum (migration 0041).
  - `#91` publisher signatures — ed25519 sign/verify + trust store
    (`pnpm pack:sign`, `DOMAIN_PACK_TRUSTED_KEYS` / `_REQUIRE_SIGNATURE`).

## Shipped 2026-07-07 (the "делай все" session) — DO NOT redo

- **Track B — `extractionProfile` is now CONSUMED + a second pack** (`#93`).
  Typed `extractionProfile` ({ guidance, fewShot }); `loadFresh` assembles
  `snapshot.extractionProfiles` from builtin + active `domain_pack` rows;
  `composeSystemPrompt` injects a `DOMAIN EXTRACTION GUIDANCE` block (empty →
  byte-identical prompt). Shipped **real_estate** as a DISTRIBUTABLE pack
  (`src/ai/domain-packs/real-estate.pack.ts` + `packs/real-estate.pack.json`,
  NOT a builtin). e2e proves install→`domain_pack`→snapshot→prompt.
- **Track D (refactor half)** — dropped both `eslint-disable complexity`
  pragmas (`#94`): `JobRunService.list` and `DreamsService.runForTenantInner`
  split into helpers, zero behaviour change. The 2 `it.skip` in
  `concurrency.real-e2e` stay skipped (infra-blocked — see track D below).
- **Track A — global pack registry** (`#96` core + `#97` CLI/seed/docs). A
  first-class in-brain registry (not a static JSON index): `registry_pack` in the
  `system` DB (migration 0042, `withAdminDb`); publish → discover →
  install-from-registry; version immutability + yank-not-delete + end-to-end
  trust; new `registry:publish` scope; `pnpm pack:publish` / `pack:search` /
  `pack:install --registry` / `registry:seed`. See `docs/domain-packs.md`.

## Open tracks — each needs a DECISION first, then code

### A. Pack discovery registry — ✅ DONE (`#96`/`#97`)
Shipped as a full in-brain registry (see "Shipped 2026-07-07"). Possible
follow-ons if ever needed: a browsable UI over `/v1/registry`, cross-instance
federation/mirroring, or download-count/popularity ranking — none required for
the core product loop.

### B. Consume `extractionProfile` / `evalFixtures` from a pack — ✅ DONE (`#93`)
`extractionProfile` is now consumed end-to-end via the **real_estate** pack (see
"Shipped 2026-07-07"). `evalFixtures` is now also consumed (`#108`): `POST /v1/admin/packs/:id/eval`
runs a pack's fixtures through the live extractor and scores pass/fail;
real_estate ships three. Nothing forward-compat remains in the manifest.

### C. Trained Layer-1 gate — DONE + PROVEN on real data (`#101`/`#103`/`#105`)
Full pipeline ships: `pnpm label:decisions` + `pnpm label:commitpackft` (Layer-2
teacher → silver JSONL, the latter pulls diverse negatives from CommitPackFT via
the HF API) → `pnpm train:decision-gate` (logistic-regression student) →
`capture:decisions --gate-model <path>` (serves behind the same
`DecisionClassifier` seam). Linear student on purpose (client-side, zero ML
runtime); DistilBERT/BiLSTM-via-ONNX is an optional upgrade behind the same seam.
**Real-run result:** brain's own history is degenerate (384 pos / 1 neg); the
gpt-4o-mini teacher over-labels, so `SilverExample.maxConfidence` +
`--min-confidence` re-threshold offline. On brain+CommitPackFT at
`--min-confidence 0.9`, the trained gate **beats the heuristic by ~17 F1**
(84.1 vs 66.9). Details + runbook in `docs/code-memory/distillation-dataset.md`;
corpus research in the `code-memory-domain` memory (don't re-run deep-research).
A **stronger teacher** shipped too (`#107`): `--verify` adds a strict LLM-judge
pass that raised precision (positive rate 94%→31% on CommitPackFT, same cheap
model). **Remaining (optional):** a `--verify`+train run on real data, an ONNX
student, a multi-label `kinds` head, and hand-checked threshold calibration.

### D. Older backlog (from prior briefs, still valid)
- **LoCoMo** full paid run + published numbers (~$110, 2-4h) — the one item left
  from `docs/roadmap/mcp-and-memory.md`.
- **Audit remainder** (`audit_next_session.md`): D-complexity `job-run.list` /
  `dreams.runForTenantInner` — ✅ DONE (`#94`). The 2 `it.skip` in
  `concurrency.real-e2e` remain (infra-blocked: namespace/db migration split for
  the cold-start test; SurrealDB rocksdb write-lock fairness for the pool-drain
  test — both covered by passing FANOUT tests). Un-skip only alongside the
  migration split, not as a standalone.

## Files to read first (per track)
- Domain packs: `src/ai/domain-packs/*` + `docs/domain-packs.md`.
- Code-memory server: `src/code-memory/*` (search / anchor services),
  `src/mcp/code-memory-tools.ts`, `src/admin/admin-code-memory.controller.ts`.
- Capture client: `src/code-memory/capture/*`, `scripts/capture-decisions.ts`.
- Pack admin: `src/admin/domain-pack-install.service.ts`,
  `src/admin/admin-packs.controller.ts`.

## Recommendation
B, the D-refactor, A (the full pack registry), and track C's **entire code path**
(silver harness + trained gate, train + serve) shipped 2026-07-07
(`#93`/`#94`/`#96`/`#97`/`#101`/`#103`). Of what's left: **C** is proven (trained gate beats the heuristic +17 F1); only
optional polish remains (stronger teacher, ONNX student, threshold calibration). **D (LoCoMo)** is a
paid one-off (~$110) — confirm before spending. **`evalFixtures`** consumption
mirrors the shipped `extractionProfile` wiring (pack → snapshot → eval harness)
and is the smallest remaining pure-code track if a pack needs fixtures.
