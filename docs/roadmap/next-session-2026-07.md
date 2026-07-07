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
   `pnpm typecheck` · `pnpm lint` (max-params=3) · `pnpm test` · `pnpm test:e2e`
   · `pnpm test:e2e:jobs`. Current baseline: **772 unit / 146 e2e / 9 jobs**.
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

## Open tracks — each needs a DECISION first, then code

### A. Pack discovery registry
**Decision needed:** where does a catalogue of installable packs live, and who
curates it? A curated JSON index served from an endpoint is the cheap first cut;
a full registry service is the big version. Nothing to build until that's chosen.
Entry points once decided: `DomainPackInstallService` (add `installFromRegistry`),
`AdminPacksController`.

### B. Consume `extractionProfile` / `evalFixtures` from a pack
Manifests already CARRY these (stored, not read). Wiring a pack's
`extractionProfile` (custom prompt/few-shot) into the extractor only pays off
once a real second domain pack exists that needs a different extraction than
core — otherwise it's speculative. **Decision:** is there a concrete second
domain (real-estate / fintech / medical) to build a pack for? If yes, build that
pack WITH an extractionProfile and wire consumption in `ExtractorService` +
`MentionExtractionService`. If no, leave it.

### C. Trained BiLSTM for capture Layer-1
The heuristic classifier (`HeuristicDecisionClassifier`) sits behind the exact
`DecisionClassifier` interface a trained model would implement. **Blocker:** no
labeled commit corpus + no training/serving pipeline in brain. This is a
data/ML track, not an app change. First step is a data plan (label commits as
decision-bearing or not — CoMRAT's OOM-Killer/Linux datasets are a starting
reference), not code.

### D. Older backlog (from prior briefs, still valid)
- **LoCoMo** full paid run + published numbers (~$110, 2-4h) — the one item left
  from `docs/roadmap/mcp-and-memory.md`.
- **Audit remainder** (`audit_next_session.md`): D-complexity `job-run.list` /
  `dreams.runForTenantInner` (refactor only if it genuinely improves); 2 `it.skip`
  in `concurrency.real-e2e` (needs namespace/db migration split).

## Files to read first (per track)
- Domain packs: `src/ai/domain-packs/*` + `docs/domain-packs.md`.
- Code-memory server: `src/code-memory/*` (search / anchor services),
  `src/mcp/code-memory-tools.ts`, `src/admin/admin-code-memory.controller.ts`.
- Capture client: `src/code-memory/capture/*`, `scripts/capture-decisions.ts`.
- Pack admin: `src/admin/domain-pack-install.service.ts`,
  `src/admin/admin-packs.controller.ts`.

## Recommendation
If the user wants forward motion with real value, **B via a concrete second
domain pack** is the highest-signal next step (it exercises + proves the whole
Domain Pack system end to end, and is the reason the pack machinery exists).
A and C are infra/data tracks; D (LoCoMo) is a paid one-off.
