# Code-memory domain — design brief + phased plan

> Self-contained brief. A **DomainPack** that makes brain remember the *why*
> of a codebase — decisions, rationale, invariants/gotchas, evolution — as
> typed bitemporal facts anchored to code, **without re-indexing the code
> itself** (that is derived state and the job of a code-search indexer like
> codeindexer.dev). Built on brain's existing primitives, not a new pipeline.

## Thesis

Brain is an invariant memory substrate (bitemporal typed facts + conflict
resolution + graph edges + procedural memory, SurrealDB-backed, MCP-exposed).
A codebase's *structure* (symbols, call graph, imports) is **derived state** —
reconstructable from source at any commit, the domain of a local code indexer.
What is **not** recoverable from the source is the engineering *why*:

- decisions and their rationale ("resolve facts through one gateway because 21
  positional args drifted between call-sites")
- invariants and gotchas ("always export a new @Injectable from the @Global
  module or e2e DI-boot goes red")
- the evolution of contracts over time (when/why a signature changed)
- rejected alternatives and agreements

This is exactly what a human maintainer keeps in their head and what we already
hand-curate in `MEMORY.md`. The code-memory domain captures it automatically,
typed, with provenance and time.

## SOTA grounding (deep-research, 2026-06; 25/25 claims verified 3-0)

| Pattern | Source | What we take |
|---|---|---|
| Auto-capture, two tiers (repo facts vs user prefs), side-effect of activity, summary-first/full-on-demand | GitHub Copilot Memory; OpenHands skills/microagents | capture is automatic + tiered; load summaries, fetch full on demand |
| Citation + just-in-time validation (re-check anchor vs current branch; invalidate, don't delete) | Copilot Memory eng blog | each fact carries a code anchor; stale anchor → `validUntil`, never delete |
| Bitemporal invalidate-not-delete (t_valid/t_invalid + transaction time) | Graphiti / Zep (arXiv 2501.13956) | **already brain's model** — confirmed SOTA; reuse `fn::resolve_fact` |
| Anchor OUTSIDE the file, hybrid edit-track + LLM semantic re-anchor, NOT offsets | Codetations (2504.18702), Magic Markup (2403.03481) | no in-code clutter; semantic re-anchor; avoid line/position anchors |
| Capture from VCS artifacts (commits/PRs/issues/review) | IBM "Code Insights" (ASE 2025); CoMRAT (MSR 2025) | trigger on PR-merge; Decision/Rationale/Supporting-Facts taxonomy = predicate schema |
| SCIP human-readable string symbol IDs, not LSIF numeric | Sourcegraph SCIP | anchor by `pkg/namespace/symbol`, survives moves, incremental re-validation |
| Triple-level provenance (per-change agent/time/artifact) | PROV-STAR / Dibowski (FOIS 2024) | extend `source` to {agent, artifact, cause} at fact granularity |
| Eval beyond pass-rate: design-constraint compliance | SWE-Shield (arXiv 2604.05955) | measure whether stored "why" raises agent design-compliance, not just recall |

**Avoid:** positional/line-offset anchors; delete-on-invalid (Catseye's failure
under `git pull`/Prettier); re-indexing the whole codebase; trusting LLM
`valid_at` without guards (Graphiti issue #1489); LSIF numeric IDs.

## Data model — on existing brain primitives

Nothing new at the storage layer; this is an ontology + thin convenience tools.

- **Entities**
  - `code_anchor` — a knowledge_entity whose externalRef is a SCIP-style symbol
    string `code:<pkg>/<namespace>/<symbol>` (NOT a line range). File-level
    anchors use `code:<repo>/<path>`.
  - `decision`, `component` — knowledge_entity of the respective type.
- **Facts** (typed, via `fn::resolve_fact` — bitemporal + conflict for free)
  Predicate pack seeded into `PredicateRegistry`, Decision/Rationale taxonomy:
  - `decided` (single_active) — a decision on a component/anchor
  - `because` (append_only) — rationale supporting a decision
  - `invariant` / `gotcha` (single_active) — a constraint on an anchor
  - `supersedes` (append_only) — decision-evolution edge
  - `validFrom` = commit author-date · `knownFrom` = index date (reuse as-is)
- **Procedural** — gotchas that should *fire* when an area is touched go into the
  existing `procedural_memory` (migration 0035): trigger="touching X" → action.
- **Provenance** — extend the fact `source` shape to triple-level:
  `{ agent: extractor|commit-author, artifact: PR#|SHA|file:line, cause }`.

## Capture triggers

- **Manual (Phase 0):** MCP `record_decision` — explicit write from an agent or
  human, mid-conversation (this is where "погнали"-style reasoning is captured).
- **Automatic (Phase 1):** on PR-merge — filter trivial diffs (comment-only /
  rename / format), LLM-extract Decision/Rationale, ingest via `fn::resolve_fact`
  (dedup/supersede free). Optional cheap BiLSTM pre-filter → LLM enrich.

## Retrieval (MCP, summary-first)

- `recall_decisions(symbol | file | topic)` — decisions/invariants for an area
- `why(symbol)` — rationale behind a code location
- `record_decision(...)` — manual capture
All wrap existing search / multi-hop / ingest; no new retrieval engine.

## Drift-resistant anchoring

- Anchor identity = SCIP symbol string (survives line shifts / file moves).
- Just-in-time validation at retrieval: does the symbol still resolve in current
  code? No → set `validUntil` on the anchored facts (invalidate, **not** delete);
  LLM semantic re-anchor as fallback when the symbol path is gone.

## Open forks (decide before Phase 1; Phase 0 independent of both)

1. **Default capture trigger:** LLM extractor (richer, costlier, needs a
   hallucination validator) vs cheap BiLSTM classifier vs layered
   (BiLSTM filter → LLM enrich).
2. **Local-vs-server:** parsing/SCIP locally, graph on server (hybrid) — the
   code-privacy question. brain is server-side multi-tenant; a local parse +
   server graph keeps source off the wire.

## Phases

### Phase 0 — PoC (this brief)
One repo, manual capture, prove the model lands on existing primitives.
- Seed the code-decision predicate pack into `PredicateRegistry`.
- `code_anchor` entity convention (SCIP-string externalRef).
- MCP tools `record_decision` + `why` (thin wrappers over ingest + search).
- **Acceptance:** record a decision on a symbol with commit provenance →
  `why(symbol)` returns it; a superseding decision marks the prior SUPERSEDED
  (existing conflict path); golden fixture + unit/e2e. No new heavy infra.

### Phase 1 — VCS auto-capture
PR-merge trigger, trivial-diff filter, LLM Decision/Rationale extraction, dedup
against existing decisions.

### Phase 2 — drift-resistant anchors
SCIP symbol-path resolution + JIT anchor validation + LLM re-anchor fallback.

### Phase 3 — eval
Per-domain golden + design-constraint-compliance dimension (agent with memory
vs without → share of design-compliant patches) + LoCoMo-style recall.

## Acceptance bar (every phase)
`pnpm exec tsc --noEmit` · `pnpm typecheck` · `pnpm lint` · `pnpm test` ·
`pnpm test:e2e` — all green. Each new MCP tool → unit test in the mcp-tools
spec. Each DB-touching feature → real-e2e. max-params ≤3 holds.
