# V9 session results — ALL-IN on BEAM (2026-08-08/09)

Protocol: docs/roadmap/next-session-v9-2026-08.md v2 (owner directives
2026-08-08: weak BEAM rows are ENGINE capability gaps — build all four
mechanisms in one session, measure in one batch; BEAM full-400 is the
ONLY scoreboard, LoCoMo demoted to a single regression guard; session
bar: the all-on combined arm ≥45 overall from 35.7). Stand: loco-321
SurrealDB 3.1.5, judge gpt-4.1-mini, provenance in every report
header, brain = `node dist/main.js` from the v9-session branch.

PR: #269 (all five builds, default-off, one branch — per the V8
stack-merge lesson). Per-mechanism verdicts land as PR comments and in
this doc.

## Phase 0 — resolver NONE-fence: BUILT + LIVE-VERIFIED

Migration 0083 guards the `CREATE ONLY` result in `fn::resolve_fact`
(REJECTED/`create_returned_none` + dead-letter instead of "Cannot
execute UPDATE statement using value: NONE" killing the whole
conversation batch), and `resolveDerivedBatch` retries a failed batch
per-row, skipping only the poisoned row with a WARN (SKIPPED rows not
counted as propositions). Live check on loco-321 (scratch tenant):
poisoned row throws cleanly per-row; good rows unaffected.

## Build 1 — derived-world lifecycle (`DERIVER_SLOT_SEMANTICS`)

Derive-internal `bitemporal_event` semantics (0083, 24-arg signature
unchanged — no caller churn): similarity+interval-gated competing
pool (aspects are topic CLASSES — trap 1), EVENT-TIME recency from
validFrom (trap 2: the batch's shared recordedAt made every update
COMPETING forever; the 0.15 margin at w_recency 0.20 is arithmetically
unreachable by score, so supersede is event-ORDERED: strictly later
validFrom wins, equal stays COMPETING for the contradiction lane,
earlier slots in as history via the extended backdated guard).

Live-verified on loco-321: INSERTED → SUPERSEDED (later validFrom) →
COMPETING (equal) → INSERTED_HISTORICAL (earlier) → append_only
untouched. Brief prereq confirmed: default reads do NOT exclude
`status='competing'` (`includeContested` defaults true), so
`detectEvidenceConflicts`' first tier receives write-side COMPETING
rows for derived worlds.

- Substrate sanity (wd-v9, 20 BEAM worlds): PASS mechanically —
  value-bearing aspects 2096 active / 160 superseded / 329 competing
  (wd-v2 had zero of both statuses by construction), event-like pure
  active; ZERO resolver incidents across ~1000 session batches.
- Leg v9lifecycle: **NEGATIVE on both target rows.** KU 16/40 vs 18/40
  (v6agg, +2/-4) and 20/40 (concurrent re-roll, +2/-6); CR 16/40 vs
  21/40 (+4/-9) and 18/40 (+5/-7). All four comparisons down.
- **Diagnosis (superseded-pair audit):** the design premise fails on
  this corpus. Dev-chat work/preferences aspects are PROGRESS
  NARRATIVES, not value slots — "trying X"→"has done X" supersedes
  remove unique detail from reads ("handling CORS errors" superseded
  by "using OpenWeather API"; a MORE specific loser replaced by a less
  specific winner), and same-day paraphrases supersede via
  time-of-day asymmetry (occurred_on 00:00 vs sessionDate hh:mm)
  instead of going COMPETING. BEAM KU/CR golds ask for the update
  STORY (old + new); the bitemporal closure hides the old at asOf.
  T3 is NOT the problem: all 9 conflict-hedged CR answers judged
  correct.
- V10 fixes grounded in the data: (1) date-granularity validFrom
  comparison in the supersede rule (same-day → COMPETING as
  designed); (2) update-story rendering — the winner carries
  supersededBy links; render "previously: <value> (until <date>)"
  into its fact line, restoring KU history WITHOUT re-including
  superseded rows in retrieval; (3) tighten the bitemporal_event
  similarity gate (sentence-cosine 0.85 clusters whole topics).

## Build 2 — mention-scan retrieval (`RETRIEVAL_TIMELINE_EVIDENCE='scan'`)

Coverage-first topic scan replacing the top-K appendix (V8 diagnosis:
coverage, not order). Topic phrase extracted deterministically;
segment record scanned BM25+embedding against the TOPIC; one dated
line per session-mention (60-min gap convention) in occurredAt order,
bounded by session count (cap 60); rides the MENTION RECORD section
unchanged; verifier parity closed (the auditor sees the same framing).

- Leg v9scan: **mechanism confirmed, content null.** event_ordering
  2.5% == baseline 2.5% (overall 37.2 = re-roll drift). The scan DID
  fire: 40/40 EO predictions changed, +250 avg prompt tokens on EO
  questions. Failure is the GENERATOR FRAME: golds want a sequence of
  ASPECT labels; ordering questions route to the enumeration lane
  whose frame ("enumerate every matching item with its date; a
  partial list is a wrong answer") fights both the exact-N constraint
  (38/40 EO questions demand exactly N items) and aspect-level
  abstraction — answers enumerate dated facts instead. Only 5/38
  violated exact-N, so the count is not the killer; granularity is.
- Fix direction (V10): a dedicated ordering frame when
  detectOrderingShape fires (item = short aspect label, order strictly
  from the mention record, honor requested N) + aspect dedup inside
  the mention record.

## Build 3 — observations v2: topic arcs (`maintenance/arcs`)

`summary_arc_*` facts: per entity, dated facts cluster into TOPICS
(projects/plans/storylines, not attribute classes), one chronological
dated narrative per topic (≤780 chars under the insight lane's
800-char budget; validFrom = latest beat; derivedFrom provenance;
atomic delete-by-recorder swap). Rides the existing insight pool
filter/budget/dispatch with zero read-path changes. Both composers
now exclude `summary_*` from their sources (self-ingestion trap).

NOTE: wd-v2 BEAM worlds PERMANENTLY carry arc rows after this queue
(same precedent as the V8 aggregates) — pair future legs accordingly.

- Leg v9arcs: **null-to-negative, and it retroactively kills the V8
  attribution.** summarization across four arms: v6agg 5/40 →
  v8insight 9/40 → v9scan (insight OFF re-roll) 9/40 → v9arcs 5/40.
  A pure re-roll moves the row +10pp — exactly the size of the V8
  "+10pp insight win", which is therefore noise, not signal. Arcs vs
  the concurrent re-roll: 1 up / 5 down.
- Coverage was thin by construction: avg 4 arcs per world over avg 2
  entities (only speakers clear the ≥4-fact floor), against
  topic-specific summarization golds. V10 direction: topic-clustered
  arcs across ALL entities, or query-time arc assembly (compose the
  narrative for the ASKED topic at read time) — the write-time slot
  is not the lever for this row.

## Build 4 — abstention (`RETRIEVAL_ABSTENTION_CALIBRATION`)

⚡ Calibration finding (the program insight of this session): the
brief's retrieval-level coverage signal CANNOT detect answer-absence
on BEAM abstention. Live probes over 8 wd-v2 worlds (16 abstention +
40 answerable questions):

- composite retrieval score: p50 0.171 (abstention) vs 0.175
  (answerable) — identical distributions, no separating floor;
- raw max cosine: p50 0.589 vs 0.603 — identical again.

BEAM abstention questions are topically ADJACENT to the conversation:
retrieval finds related facts at normal similarity; what is missing is
the ANSWER, not the topic. The floors ('coverage' mode) are kept for
genuinely off-topic traffic with the finding recorded in catalog/ops.

The shipped mechanism is answer-level: `'verifier'` mode — in lenient
guardrails an unsupported/partial verifier verdict returns the
explicit not-in-my-memory decline (reason `low_coverage`) instead of
ungrounded text; zero extra cost (the verifier already runs there);
'answer' guardrails exempt, so the other nine BEAM rows are
structurally untouched.

- Leg v9abstain: **the session's one confirmed win.** Abstention row
  0.675 vs 0.400 (v6agg exact) = **+27.5pp on the target row** (16→27
  of 40), well beyond the ±5-12pp band. The other nine rows are
  structurally exempt ('answer' guardrails skip the verifier) —
  overall 33.9 vs 35.7 is re-roll drift. Residual 13/40: the verifier
  says 'supported' on fabrications assembled from real facts (each
  claim individually grounded, the causal link fabricated) — next
  lever is a question-topic coverage check in the verifier prompt,
  own leg required (global verifier semantics).
- NOTE: in the combined arm the abstention row reads 0.50 — the
  insight/scan lanes change the evidence bundle and shift verifier
  verdicts; the solo-arm number is the mechanism's clean read.

## Build 5 (carried) — volume-neutral salience grading

`DERIVER_SALIENCE_STAMP` v2: extraction passes never see the word
"salience" (byte-identical prompt/schema either way — the V8 in-prompt
section primed +54-74% over-emission and failed both gates); a
separate cheap grading turn scores the final proposition list against
a rubric with explicit mass targets (~10/60/25/5); failures degrade to
unstamped.

- Distribution gate: PARTIAL PASS — 5.9/44/47.6/2.6 vs rubric
  10/60/25/5. Grade 3 fixed (2.6 vs V8's 11.7), grade 0 near-target
  (5.9 vs V8's 0.4), grade 2 still inflated (47.6 vs 25).
- Volume-parity gate: **PASS decisively** — wd-v9 5002 vs wd-v2 4955
  propositions (+0.9%; the V8 in-prompt section was +54..74%).
  Weight refit remains meaningful; read A/B not re-run this queue.
- SSA bigger-n routed confirm: NOT RUN this queue (needs a larger SSA
  slice than the n=56 world set; carried).

## Measurement queue (one chain, contamination-ordered)

1. v9scan (wd-v2 clean) 2. v9abstain (wd-v2 clean) 3. arcs→wd-v2 +
v9arcs 4. wd-v9 substrate (slot semantics + salience v2 + aggs +
arcs) + sanity 5. v9lifecycle 6. v9combined (all-on; session score)
7. LoCoMo dev-5 guard (read mechanisms on, vs w8cp 76.1). Gates:
checkpoint completeness (400 rows) per leg; quota grep before
trusting any number (V8 lesson); ONE heavy chain on loco-321.

## LoCoMo regression guard

Guard (dev-5 QA, scan+insight+abstention ON, locow8/wd-v2):
**75.1% (n=762 judged) vs w8cp baseline 76.1% — −1.0pp, n.s.**
(σ≈1.6pp per arm; per-question pairing unavailable across the two
report id conventions). As expected structurally: the scan lexicon
fires 0/999 on dev-5, the insight slot needs router lanes (off in the
LoCoMo read env), abstention 'verifier' is exempt in 'answer'
guardrails — the guard certifies the refactored answer path, and no
mechanism goes back to off.

## Verdicts (one line each)

- Phase 0 fence: BUILT + live-verified; zero incidents on the full
  wd-v9 derive.
- B1 lifecycle: mechanism verified, ARM NEGATIVE — design premise
  (value slots) wrong for dev-chat corpora; three grounded V10 fixes.
- B2 mention-scan: mechanism fires, ARM NULL — generator frame, not
  retrieval; ordering frame is the V10 fix.
- B3 arcs: ARM NULL-NEGATIVE; V8's +10pp insight attribution
  retracted (re-roll noise reaches +10pp on this row).
- B4 abstention 'verifier': **CONFIRMED +27.5pp** on the target row,
  rest structurally flat. The default-candidate of this session.
- B5 salience v2: volume-parity PASS (+0.9%), distribution partial;
  read A/B pending refit.

## Session score

**v9combined overall 34.5% (138/400) vs the ≥45 bar — MISSED**; flat
vs the 35.7 baseline. The bar assumed +4-6pp per mechanism; the
program's measured reality: the write-side lifecycle premise is wrong
for this corpus, the summarization row is noise-bound at n=40, and
the one real capability gain (abstention) is worth ~+2.75pp overall
at most. The V9 diagnosis set (update-story rendering, ordering
frame, query-time arcs, verifier topic-coverage) is the V10 agenda —
each grounded in per-question evidence, not row drift.

## Program-level findings

1. **Answer-absence is not retrieval-detectable** on adjacent-topic
   benchmarks: composite score AND raw cosine distributions are
   IDENTICAL for abstention vs answerable questions (p50 0.171/0.175;
   0.589/0.603). Coverage must be judged at the answer level.
2. **BEAM per-row noise at n=40 reaches ±10pp** (summarization
   5/9/9/5 across four same-ish arms) — single-arm row deltas below
   ~15pp are unreadable; only concurrent McNemar pairs count.
3. **knowledge_update rewards the update STORY, not the current
   value** — hiding superseded history at read time makes the row
   WORSE, not better.
