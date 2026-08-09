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

- Substrate sanity (wd-v9, 20 BEAM worlds): TBD (status × aspect
  class, salience distribution, volume parity vs wd-v2)
- Leg v9lifecycle (wd-v9, v6agg-equivalent read env) vs beam-100k-v6agg
  — target rows knowledge_update + contradiction_resolution: TBD

## Build 2 — mention-scan retrieval (`RETRIEVAL_TIMELINE_EVIDENCE='scan'`)

Coverage-first topic scan replacing the top-K appendix (V8 diagnosis:
coverage, not order). Topic phrase extracted deterministically;
segment record scanned BM25+embedding against the TOPIC; one dated
line per session-mention (60-min gap convention) in occurredAt order,
bounded by session count (cap 60); rides the MENTION RECORD section
unchanged; verifier parity closed (the auditor sees the same framing).

- Leg v9scan (wd-v2 clean) vs beam-100k-v6agg — target event_ordering,
  secondaries temporal_reasoning + summarization: TBD

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

- Leg v9arcs (wd-v2 + aggregates + arcs, insight routed) — target
  summarization vs the 22.5 v8insight bar (NOT the 12.5 control): TBD

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

- Leg v9abstain (wd-v2 clean, verifier mode) — target abstention row,
  rest flat: TBD

## Build 5 (carried) — volume-neutral salience grading

`DERIVER_SALIENCE_STAMP` v2: extraction passes never see the word
"salience" (byte-identical prompt/schema either way — the V8 in-prompt
section primed +54-74% over-emission and failed both gates); a
separate cheap grading turn scores the final proposition list against
a rubric with explicit mass targets (~10/60/25/5); failures degrade to
unstamped.

- Distribution + volume-parity gates on the wd-v9 substrate: TBD
- SSA bigger-n routed confirm: NOT RUN this queue (needs a larger SSA
  slice than the n=56 world set; carried).

## Measurement queue (one chain, contamination-ordered)

1. v9scan (wd-v2 clean) 2. v9abstain (wd-v2 clean) 3. arcs→wd-v2 +
v9arcs 4. wd-v9 substrate (slot semantics + salience v2 + aggs +
arcs) + sanity 5. v9lifecycle 6. v9combined (all-on; session score)
7. LoCoMo dev-5 guard (read mechanisms on, vs w8cp 76.1). Gates:
checkpoint completeness (400 rows) per leg; quota grep before
trusting any number (V8 lesson); ONE heavy chain on loco-321.

## Verdicts

TBD per arm (target rows, McNemar vs beam-100k-v6agg pairs, noise
±5-12pp per row at n=40).

## Session score

TBD: v9combined overall vs the ≥45 bar (from 35.7).
