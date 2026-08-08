# Next session — V9: ALL-IN on BEAM (2026-08)

Owner directives (2026-08-08, two, verbatim intent):
1. The weak BEAM rows are ENGINE capability gaps — contradiction ~50,
   knowledge_update ~47, instruction ~42, abstention ~42, MSR ~37,
   info_extraction ~29, temporal 20-32, summarization 22.5,
   event_ordering 2.5. No audits, no judge-style work — build the
   engine.
2. Build EVERYTHING in one session (the V8-proven mode), measure in
   one batch at the end. **BEAM full-400 is the ONLY scoreboard.**
   LoCoMo is demoted to a single regression guard.

Session bar: the all-on combined arm reaches **≥45 overall** (from
35.7). Per-mechanism potential: lifecycle +4-5, mention-enumeration
+5-6, observations +2-3, abstention +2-3. Anything less than +3pp per
mechanism on its target rows is a recorded null — BEAM per-row noise
is ±5-12pp at n=40, so verdicts read TARGET ROWS, not overall drift.

## Phase 0 — fence the resolver bug (blocks everything write-side)

The V8 open bug: derive died with SurrealDB "Cannot execute UPDATE
statement using value: NONE" (data-dependent; suspect: the
unresolved-subject fallback collapsing two subjects onto one entityId
in one batch). Reproduce via a synthetic batch through that exact
path; fix or fence with a per-row try/skip + WARN. Do this FIRST —
block 1 multiplies write-path traffic.

## Build 1 — derived-world lifecycle (knowledge_update + contradiction)

Batch derive hardcodes semantics:'append_only' → derived worlds have
NO supersede and NO competing; two rows structurally starve and every
row pays the stale-noise tax.

Build: aspect-classed semantics behind DERIVER_SLOT_SEMANTICS
(default off, golden owner-review). TWO TRAPS PRE-ANALYZED — do not
rediscover:

1. **Aspects are TOPIC CLASSES, not slots.** single_active competes
   over ALL (entity, aspect) candidates with no similarity gate — it
   would collapse "works at Foo" and "wants a better resume" (both
   aspect=work) to one fact. Value-bearing aspects (residence, work,
   health, possessions, preferences, identity, education) take
   **'bitemporal'** — the competing pool is cosine-gated (≥0.83) +
   interval-overlapping, so only value-variants of the same claim
   meet. Event-like aspects (events, activities, media, travel,
   plans…) stay append_only. Derived rows score ~0.69 vs reject 0.35
   — safe from the dead-letter gate.
2. **Batch derive breaks recency.** All rows share recordedAt=now →
   a value change scores EQUAL to its incumbent → margin 0 →
   COMPETING forever, and default reads EXCLUDE status='competing' —
   knowledge_update would get WORSE. Derived worlds need event-time
   recency: score recency from validFrom (session date) instead of
   recordedAt. Preferred: a cfg flag into fn::resolve_facts
   (migration, one write primitive stays — S4); fallback: deriver
   pre-sorts by validFrom and resolves value-clusters itself.

Also verify BEFORE building: how detectEvidenceConflicts receives
COMPETING rows given the default read excludes them (T3 worked on
live ingest — confirm the path exists for derived worlds, else the
contradiction half of this build is dead on arrival).

Target rows: knowledge_update, contradiction_resolution.

## Build 2 — mention-enumeration retrieval (event_ordering 2.5)

V8 diagnosis: coverage, not order. Golds want a curated K-item
sequence of topic aspects across ALL sessions; top-K similarity
windows cannot enumerate it.

Build: for ordering/enumeration-routed questions (merged skeleton:
detectOrderingShape + RETRIEVAL_TIMELINE_EVIDENCE), a topic-scan
retrieval — extract the topic phrase, scan the episodic record per
session (BM25 + embedding against the TOPIC, not the whole question),
emit ONE dated line per session-mention in occurredAt order. Bounded
by session count, not top-K. Feed it as the mention record (header
already merged).

Target rows: event_ordering; secondaries temporal_reasoning,
summarization.

## Build 3 — observations v2: topic arcs (summarization 22.5)

The insight SLOT is merged and pays (+10pp); the CONTENT is weak —
aspect aggregates are attribute rollups, the leaders' observations
are topic ARCS ("started planning the move in March, chose Austin in
May, signed in June"). Build an arc-composer at derive time: per
entity per topic cluster, ONE dated narrative summary written as
summary_arc_* facts — they ride the existing insight pool filter
(predicate prefix), budget slot, and dispatch unchanged.

Target row: summarization (bar = 22.5, the v8insight arm, NOT the
12.5 control).

## Build 4 — abstention calibration (~42)

The abstention row rewards refusing when memory has no answer; we
score ~42 by accident. The conformal machinery idles on BEAM. Build:
a memory-coverage signal (top-score floor + evidence-count floor) →
an explicit "not in my memory" answer, behind a profile point.
Risk to watch in the leg: over-abstaining regresses the other nine
rows — the verdict reads abstention UP AND the rest flat.

Target row: abstention.

## Build 5 (carried, fits between) 

- Volume-neutral salience grading: a separate cheap grading turn over
  the emitted proposition list (the in-prompt section inflated
  extraction +54-74%); weights refit to real mass. Read fold merged.
- Bigger-n SSA routed confirm (+3.6 n.s. at n=56 awaits power).

## Measurement batch (ONE queue at the end, loco-321, one chain)

1. Fresh-tenant derive with lifecycle ON (w8 recipe + slot
   semantics, fresh version) — substrate sanity: supersede/competing
   counts per aspect class.
2. BEAM full-400 arms vs beam-100k-v6agg: per-mechanism (lifecycle /
   mention-enum / observations / abstention) + ONE all-on combined.
   Read TARGET ROWS per arm; combined arm is the session score.
3. LoCoMo dev-5 regression guard: ONE QA vs locomo-w8cp-dev5 with
   the read-side mechanisms on — non-negative or the offending
   mechanism goes back to off.
4. Quota check BEFORE trusting any number: grep "no credits
   remaining" in brain logs (V8: quota death poisons silently).

## Stand crib

V8-verified: one heavy chain per loco-321 (OOM ×4 now); THROTTLE_
DISABLED=1; --ignore-workspace; checkpoint-completeness gates; BEAM
worlds carry aggregates permanently (pair vs *-agg reports); derive
scopes to one conversation ({conversation: id}); worlds wd-v2 +
wd-sal1 live on locow8; BEAM row noise ±5-12pp at n=40; datasets:
/tmp/beam_100k.json via scripts/fetch-beam-dataset.py --split 100K,
LME via HF longmemeval_s (curl -C -).

## Definition of done

- All four mechanism builds merged-ready (default-off points, gates
  green) — no cutting from the bottom, the owner ordered ALL.
- The measurement batch executed; per-mechanism verdicts on target
  rows + the combined-arm score recorded in a v9 results doc.
- Combined ≥45 = session pass; misses analyzed per mechanism, not
  averaged away.
- Memory + MEMORY.md updated; no eval forks.
