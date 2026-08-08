# Next session — V9: engine, not tuning (2026-08)

Owner directive (2026-08-08, verbatim intent): the weak BEAM rows are
capability gaps of the ENGINE — contradiction ~50, knowledge_update
~47, instruction ~42, abstention ~42, MSR ~37, info_extraction ~29,
temporal 20-32, summarization 22.5, event_ordering 2.5 — none of them
improves from audits or judge-style work. Build the engine.

V8 calibrated the economics: one good structural leg moved its target
row +10pp and the overall +1.0pp; rows are 10% each; per-row noise at
n=40 is ±5-12pp, so only mechanisms with ≥10pp-per-row potential are
measurable. Volume-null ×2 closed extraction recall as a vector; the
ceiling lives in retrieval/synthesis and in WRITE-SIDE SEMANTICS.

Ordered by expected pp per build. Each block self-contained.

## 1. Derived-world lifecycle (THE structural hole — two rows + global)

The batch deriver writes every proposition append_only
(fact-resolver.resolveDerivedBatch hardcodes semantics:'append_only').
A derived world therefore has NO supersede and NO competing:

- knowledge_update (~47): every historical value of a slot stays
  'active' beside the current one; recency scoring is the only
  defense — the generator regularly answers with the stale value.
- contradiction_resolution (~50): write-side contradictions are never
  marked COMPETING in derived worlds, so the T3 conflict lane — which
  took live-ingest BEAM contradiction 0→52 — structurally starves.
- Every other row pays the stale-noise tax in the fact budget.

Build: aspect-classed semantics at derive time. The deriver's aspect
slugs are a CLOSED vocabulary (identity, residence, family,
relationships, pets, activities, work, education, health, possessions,
events, plans, preferences, media, travel, other) — classify each as
value-bearing (residence, work, health, possessions, preferences… )
or event-like (events, activities, media… → stays append_only).
Plumbing exists end-to-end: fn::resolve_fact takes semantics per row
and resolution is namespace-local (0079), so lifecycle inside a
version cannot touch other worlds. Extraction-profile point
DERIVER_SLOT_SEMANTICS off|on, default off, golden owner-review.

TWO DESIGN TRAPS already analyzed — do not rediscover them:

1. **Aspects are TOPIC CLASSES, not slots.** single_active competes
   over ALL candidates of (entity, aspect) with no similarity gate —
   it would collapse "Craig works at Foo" and "Craig wants to improve
   his resume" (both aspect=work) to one surviving fact. The correct
   semantics for value-bearing aspects is **'bitemporal'**: the
   competing pool is similarity-gated (cosine ≥ threshold + interval
   overlap), so only actual value-variants of the same claim meet —
   "lives in Toronto" vs "lives in Austin" compete; unrelated
   work-facts coexist. (Reject-threshold check: derived rows score
   ~0.69 vs reject 0.35 — safe.)
2. **Batch derive breaks recency scoring.** In one derive run every
   row has recordedAt = now, so a value change scores EQUAL to the
   incumbent (margin 0 → COMPETING, never SUPERSEDED) — and default
   reads EXCLUDE status='competing', so knowledge_update would get
   WORSE, not better. The derived world needs event-time recency:
   score recency from validFrom (the session date) instead of
   recordedAt for derived batches — either a resolver variant (cfg
   flag into fn::resolve_facts; migration) or pre-resolution in the
   deriver (sort by validFrom, resolve sequentially per (entity,
   aspect, similarity-cluster), emit supersede pairs itself). Decide
   at build time; the resolver-side variant keeps ONE write
   primitive (S4) and is preferred.

Also on this path: the open UPDATE-NONE resolver bug (V8,
data-dependent, suspected unresolved-subject fallback — two subjects
collapsing onto one entityId in one batch) — fix or fence FIRST;
check how detectEvidenceConflicts receives COMPETING rows given the
default read excludes them (the T3 lane worked on live ingest —
verify the path before assuming it fires for derived worlds).

Legs: fresh tenant, w8-recipe derive with slot semantics on a fresh
version; BEAM full-400 vs v6agg reading knowledge_update +
contradiction_resolution + overall; MS guard block.

## 2. Mention-enumeration retrieval (event_ordering 2.5 + enumeration)

V8 diagnosis: the golds want a curated K-item sequence of topic
aspects across ALL sessions; top-K similarity windows structurally
cannot enumerate it — coverage, not order, is the gap.

Build: for ordering/enumeration-routed questions (dispatch skeleton
RETRIEVAL_TIMELINE_EVIDENCE + detectOrderingShape already merged), a
topic-scan retrieval: extract the topic phrase from the question,
scan the EPISODIC record (episodes or segments) per session for topic
matches (BM25 + embedding against the topic, not the whole question),
emit ONE line per session/mention — date + what was raised — in
occurredAt order, as the mention record. This is a coverage-first
enumeration over the whole record, bounded by sessions count, not
top-K.

Legs: BEAM full-400 vs v6agg-era control, event_ordering as the
target row, temporal_reasoning + summarization as secondaries.

## 3. Observations layer v2 (summarization 22.5 → the leaders' shape)

The insight SLOT is merged and pays (+10pp summarization); the
CONTENT is weak — aspect aggregates are entity-attribute rollups,
while Hindsight-class "observations" are topic ARCS ("X started
planning a move in March, chose Austin by May, signed the lease in
June"). Build an arc-composer at derive time: per entity per topic
cluster, a dated narrative summary written as summary_arc_* facts
(they ride the existing insight pool filter by predicate prefix).
Reuses: the insight lane, budget slot, dispatch — content-only change.

Legs: BEAM summarization row vs the v8insight arm (the new bar is
22.5, not the 12.5 control).

## 4. Abstention calibration (~42 → honest "not in memory")

The abstention row rewards refusing when memory has no answer; we
score ~42 by accident (never-abstain answer mode + sentinel). The
conformal guardrail machinery exists and is BEAM-idle. Build: a
memory-coverage signal (top-score floor + evidence-count floor per
question class) that flips the BEAM answer mode to an explicit "not
in my memory" — behind a profile point, measured on the abstention
row WITHOUT regressing the other nine (the risk is over-abstaining).

## 5. Carried / small

- Salience v2 (write side): volume-neutral grading — a separate
  cheap grading turn over the emitted proposition list (the V8
  in-prompt section inflated extraction +54-74% and the grades
  0.4/36/52/11.7); weights refit to real mass; then re-A/B on the
  clean same-world pair. Read fold + profile points are merged.
- Resolver UPDATE-NONE bug (V8, open): reproduce via the
  unresolved-subject fallback path (two subjects → one entityId in
  one batch); fence before block 1 ships.
- SSA routed confirm at bigger n (the +3.6 n.s. at n=56).
- Appendix segment lane budget — ONLY with its own leg (the E16 78.7
  record recipe depends on unbudgeted windows).

## Stand crib (V8-verified additions)

- ⚠️ QUOTA: OpenAI credits dying mid-leg poisons SILENTLY — runner
  exits 0, predictions empty, judge scores 0. Check `grep "no credits
  remaining" brain-*.log` BEFORE trusting any leg number; quarantine
  poisoned reports as *.quotadeath.
- BEAM per-row noise: ±5-12pp at n=40 between identical-config runs
  (measured, v8timeline vs v6agg on untouched rows). Only ≥10pp-class
  mechanisms are measurable per row.
- Derive endpoint scopes to one conversation: POST
  /v1/admin/maintenance/derive {version, force, conversation: id} —
  point re-derives instead of full-world re-runs.
- Worlds on locow8: wd-v2 (w8cp, completion pass) and wd-sal1
  (salience-stamped, +60% volume) both live for read-side experiments.
- Everything else: the V8 crib in next-session-v8-2026-08.md stands
  (one chain per stand, --ignore-workspace, THROTTLE_DISABLED=1,
  checkpoint-completeness gates, agg-контролы).

## Definition of done

- Block 1 verdict on knowledge_update + contradiction rows (the two
  structurally-starved rows move or the diagnosis is falsified).
- Block 2 verdict on event_ordering.
- Every leg vs the correct control, provenance in headers, results in
  a v9 results doc; no eval forks — semantics enter as profile/
  extraction points, gates enforce.
