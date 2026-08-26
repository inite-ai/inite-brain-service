# Brain v2 — Retention as resolution: the tier ladder as SERVING policy (2026-08)

Companion to [brain-v2-2026-08.md](brain-v2-2026-08.md) (the wave doc — this is PR8's
design note), [memory-research-2026-08.md](memory-research-2026-08.md) (§8-9, the fovea
cascade this ladder extends downward), and [fovea-optics-2026-08.md](fovea-optics-2026-08.md)
(the read-side focusing policy; this doc is its storage-side mirror).

The thesis: **retention is not deletion, it is resolution.** A memory's age changes how
sharply it is _served_, never whether it _exists_. The L0-L3 ladder already states this
for the read path (the same memory servable as semantic prior, fact index, raw window, or
full session); the resolution tiers state it for the write/retention path — hot, warm,
cold, and archive are serving contracts, not lifecycle stages. Nothing in this ladder is
a delete: GDPR erasure (the forget/tombstone path) is the only mechanism that removes
content, and it cuts across every tier identically.

## 1. The ladder

| Tier        | Serving contract                                                                                                                                  | Storage state                                                                                                                                                                                                                                                           | Status |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **hot**     | Full serving: raw windows, episodes, facts, digests — every lane, every ladder rung (L0-L3)                                                       | Facts carry embeddings; episodes/segments servable (`src/search/retrieval-profile.ts:723` rawWindowSpan, `src/synthesize/l3-escalation.service.ts:126`)                                                                                                                 | today  |
| **warm**    | Summaries serve in place of members; members leave every read surface but stay auditable and provenance-reachable                                 | Today's compacted state reframed: `status='compacted'`, embedding stripped (`src/compaction/compaction-runner.service.ts:147`), hidden by every read lane (`src/search/internals/where-builder.ts:192`), still walkable via `derivedFrom` (provenance closure, PR #371) | today  |
| **cold**    | Schema + index only: the summary row plus an outcome-stat pointer serve; no BM25 body, no vector — a hit tells you _that_ and _where_, not _what_ | Future: summary + `memory_outcome_stat` pointer (0107), body evicted from the analyzed index                                                                                                                                                                            | future |
| **archive** | Source pointer only: a stable reference to the evidence origin (export/blob/upstream system); serving requires explicit re-hydration              | Future                                                                                                                                                                                                                                                                  | future |

The tier transitions are the existing compaction/promotion passes — this PR makes their
schedule per-tenant and their consolidation honest; it does not add a tier column.
"Which tier a row is in" stays derivable from row state (embedding presence, status,
index membership), the same way L0-L3 are query-time choices rather than storage types.

## 2. What ships in this PR (the per-tenant schedule + the consolidation gate)

| Piece                                                                    | Where                                                           | Behavior                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPACTION_TENANT_OVERRIDES` parser                                     | `src/compaction/compaction-overrides.ts`                        | JSON env mapping companyId → `{ hotRetentionDays?, promotionAgeDays?, promotionMinGroup?, promotionMinEpisodes? }`; call-time read, fail-open per tenant                                                                                                  |
| Boot-shape validation                                                    | `src/common/env-validation.ts` (validateCompactionOverridesEnv) | Clones the RETRIEVAL_PROFILE_OVERRIDES shape check but WARNS, never throws — a malformed schedule degrades to the global one                                                                                                                              |
| Hot-retention override                                                   | `src/compaction/compaction-runner.service.ts:89`                | `override.hotRetentionDays ?? COMPACTION_HOT_RETENTION_DAYS` (default 90)                                                                                                                                                                                 |
| Promotion schedule override                                              | `src/compaction/promotion-runner.service.ts:119`                | `promotionAgeDays`/`promotionMinGroup` overlay the process defaults (180/5)                                                                                                                                                                               |
| Corroboration floor (`COMPACTION_PROMOTION_MIN_EPISODES`, default 0=off) | `src/compaction/promotion-runner.service.ts:242`                | A group folds only when its members span ≥ N DISTINCT evidence contexts (union of member `source.episodeIds` + `source.conversationId`) — five facts from one conversation are one witness, not five; below the floor the group is skipped (logger.debug) |
| Conflict guard (`COMPACTION_PROMOTION_CONFLICT_GUARD`, default off)      | `src/compaction/promotion-runner.service.ts:267`                | Sibling `status='competing'` rows on the same (entity, predicate, user-scope) ABORT the group loudly (logger.warn "contested group NOT promoted") — a contested group must never fold silently into one summary                                           |

Gate order inside `promoteGroup`: corroboration floor → conflict guard → the existing
summarize/create/compact flow. Everything is default-off/unset: with no env set, every
query, log line, and written row is byte-identical to today (pinned in
`test/promotion-gate.unit-spec.ts`).

Why the gate belongs to the resolution story: demotion to warm is LOSSY for serving (the
members leave the read surface; the summary is the only carrier). A lossy demotion is
safe only when the summary genuinely consolidates — corroborated across independent
evidence contexts, and uncontested. The floor and the guard are the two admission checks
that make "warm" a consolidation, not a compression artifact.

## 3. Strong-cue re-zoom (future, sketch)

The ladder's missing rung: a strong retrieval cue on a warm/cold memory should be able to
_re-sharpen_ it on demand — the storage-side mirror of L3 escalation.

Sketch (no code in this wave):

- **Trigger**: a warm summary is served as a top-ranked hit N times in a window
  (`memory_outcome_stat` from PR6 is exactly this counter), or an L3 escalation lands in
  a conversation whose facts are compacted.
- **Act**: re-embed the summary's members (embeddings are derived state — the text never
  left; `embedding = NONE` is reversible by construction) and/or re-run the recompose
  pass over the group (`src/compaction/recompose.service.ts:171` invalidate → recompute
  is the existing re-derive machinery to reuse).
- **Bound**: per-tenant re-zoom budget per run (same shape as
  `COMPACTION_PROMOTION_MAX_GROUPS`), and a demotion cooldown so a memory cannot
  oscillate hot↔warm.
- **Non-goal**: automatic un-compaction on every read — that would make retrieval
  self-reinforcing again, the exact gap #7 failure mode PR7's verified-use signals exist
  to close. Re-zoom keys off _verified_ use, never mere retrieval.

## 4. Carve-out: resolution tiers and staleness are orthogonal, permanently

Two mechanisms share the words "old summary" and must never be confused:

- **Staleness (0072/0089) — a CORRECTNESS property.**
  `src/db/migrations/0072_derived_staleness.surql:49` defines
  `fn::mark_derived_stale`: when a parent fact is superseded/retracted, the
  reverse-`derivedFrom` closure gets `staleAt`/`staleReason`, and the recompose pass
  re-derives the artifact over its surviving parents.
  `src/db/migrations/0089_staleness_event.surql:80` moves the marking to write time (a
  four-clause storm-guarded DEFINE EVENT on the status transition); the nightly drain
  (`src/compaction/recompose.service.ts:171`) stays as the backstop. A stale summary is
  _possibly wrong_ and keeps serving only until recomputed.
- **Resolution (this doc) — an ECONOMICS property.** A warm summary is _cheaper_, not
  suspect. Demotion says nothing about truth; it says the tenant's schedule stopped
  paying for full resolution.

The carve-out, both directions:

1. **Tier transitions never mark staleness.** Compaction/promotion set
   `status='compacted'` on members in the same pass that creates their summary — 0089's
   guard deliberately omits `'compacted'` from its transition vocabulary
   (`0089_staleness_event.surql:36`, clause 3) precisely so demotion cannot mark every
   summary stale at birth. Per-tenant schedules and the consolidation gate change _when_
   and _whether_ that pass runs — they add no new status transitions, so the invariant
   is untouched by this PR.
2. **The staleness machinery never changes tiers.** `fn::mark_derived_stale` writes only
   `staleAt`/`staleReason` (0072:54-62); recompose re-derives content and may retract an
   orphan whose parents are all gone, but it never sets `status='compacted'`, never
   strips an embedding for economic reasons, and never consults the retention schedule.

A future cold tier keeps the same contract: eviction from the BM25 index is a serving
decision and must not touch `staleAt`; a stale cold summary is simply both — cheap AND
awaiting recompute — and the two flags resolve independently.

## 5. Measurement posture

Parked with the paid-eval budget, like the rest of the wave
([brain-v2-2026-08.md](brain-v2-2026-08.md) §5). Nothing here flips a default. What the
PR buys for free: a tenant-shaped retention schedule (an enterprise tenant can hold hot
at 365d while a trial tenant compacts at 30d — one process), and promotion that cannot
manufacture false confidence (single-witness groups and contested groups no longer fold).
When the budget returns, the levers measure like every other lever — strict-currency,
ablation-mined, full-pack confirm before any default flip; the natural first
question is whether the corroboration floor changes summary-lane precision on the
BEAM/LME summary classes.
