# Refactor validation — V1-V3 results (2026-08-03)

Protocol: docs/roadmap/next-session-validate-2026-08.md. The S1-S5
platform refactor (31eec33..f0395ee) was 1782 unit tests deep and zero
live evals wide; this session closes the gap with a paired equivalence
smoke on all three axes and takes the branch to prod.

## V1 — self-describing reports (31a9f48)

Every eval report header now carries `provenance`: git SHA + dirty
flag + branch of the driving checkout, plus the brain's resolved
RetrievalProfile fetched live from the new
`GET /v1/admin/retrieval-profile` (brain:admin; lanes serialized as a
sorted array). All three runners print the one-line gist into the leg
log up front — the V2 legs below are the first artifacts to carry it.
Offline re-grade (`--judge-report`) now preserves the original run's
provenance and ingest block instead of silently dropping them.

## V2 — equivalence smoke, three axes

All legs: refactored code at 31a9f48, profiles expressed the NEW way
(canonical keys; deleted keys absent), loco-321 SurrealDB 3.1.5,
strict binary judge gpt-4.1-mini — same judge as every baseline.

### BEAM-100K spot (~100q) — PASSED, n.s.

B0-winning config re-expressed as a profile: router lanes on via
`SYNTHESIZE_ANSWER_ROUTER_ENABLED=1` (→ 6 lanes, no instruction),
`dateAnchoring=absolute`, `verbatim=shape_conditioned` — vs
`var/beam-100k-b0-0803.json` (B0, judged 35.3% full-400). Report
`var/beam-100k-v2spot.json`, first 5 conversations = 100 questions,
errored=0, one attempt.

Paired McNemar over the 100 common questions:

- **overall 41.0% → 43.0% (+2.0pp, p=0.80, n.s.)** — 7 losses / 9
  wins, no collapse.
- Per-ability: no ability moved beyond noise (n=10 each).
  contradiction_resolution 40→30 is ONE net flip (p=1.0) — inside the
  documented CR noise corridor (±8pp means nothing even at n=40, see
  measure-ladder-2026-08-results.md). instruction_following 40→70
  (+3 clean wins, p=0.25 n.s.) — watch-item, not a claim.
- avgPromptTokens 4843 (B0 full-run: 5037) — same envelope.

Verdict: the read path over the existing derived substrate is
behavior-preserved. (Spot is QA-only by design — the write path is
covered by the LoCoMo full re-ingest and the LME fresh-world legs.)

### LoCoMo dev-5 — first leg MISCONFIGURED (brief error), corrected leg running

The brief said the LoCoMo profile is "RETRIEVAL_DATE_ANCHORING=none;
no other pins" — that is materially incomplete. The first leg (v2eq,
`var/locomo-v2eq-dev5.json`) ran exactly that and scored **62.1% vs
74.4% (−12.3pp, p=1.2e-11)** — temporal −22.4pp, single-hop −11.7pp.
Flip forensics: dated facts missing ("The facts do not specify when…"
where E15 cited knowledge_fact ids with dates) and relative dates
resolved against wrong anchors ("last Friday" → October instead of
July).

Root cause — the leg, not the engine. The E-lineage record substrate
(locomo_sota memory, P2/E3/E9 records) is:
- write: dialogue-vocabulary extraction (`EXTRACTOR_DIALOGUE_PROFILE=1`)
  + event-time validFrom (`INGEST_EVENT_TIME_EXTRACTION=1`, the key the
  memory calls OCCURRED_ON) + episode substrate + captions;
- then wd-v2 window derivation + segment composition over it;
- read: QA pinned to the derived world (`RETRIEVAL_DERIVED_VERSION=wd-v2`)
  with all verbatim lanes on (old `SEARCH_SEGMENT_LANE_ENABLED=1`, new
  `RETRIEVAL_VERBATIM_EVIDENCE=always`).

The v2eq leg re-ingested with the CLOSED vocabulary (the S4 boot
default), never derived, never composed segments, and read raw facts
only. As an unintended ablation it says: engine defaults
(assistant-chat shape) score 62.1 on diary-genre LoCoMo — the genre
law, measured once more from the other side.

Corrected leg (v2eq2) — **PASSED, n.s. (nominally the best dev-5 in
the lineage)**. Fresh tenant `locov2`, dialogue write profile +
event-time + captions, wd-v2 derive (1878 propositions / 5
conversations, unresolved 1 — E3 era: 1811/5, unresolved 5), segments
**1286 — bit-identical to E9's count**, QA on the derived world with
`verbatim=always` + `dateAnchoring=none`. Report
`var/locomo-v2eq2-dev5.json`, dead=8.

**Paired McNemar vs E15: headline 74.4% → 76.6% (+2.2pp, p=0.14,
n.s.)**; multi-hop 56.3→63.4 (+7.0 n.s.), temporal 82.7→79.5 (−3.2,
p=0.38 n.s.), open-domain flat, single-hop 81.1→84.0 (+2.9 n.s.),
adversarial flat. 76.6 nominally beats the E10 dev-5 record (75.5) —
claimed as equivalence, not a record (n.s.).

## V2 verdict — GREEN on all three axes

The refactored single path, with profiles expressed through the
canonical keys, reproduces the pre-refactor numbers on quality
(LoCoMo +2.2pp n.s.), capacity (LME exact parity p=1.0), and scale
(BEAM spot +2.0pp n.s., no ability collapse). The one real deviation
found all session was an eval-config error (the brief's "no other
pins"), not an engine regression — and its diagnosis doubled as a
measured genre-law data point.

### LME smoke (~50q, lane-OFF protocol) — PASSED, exact parity

Profile-off default engine (no router flag → lanes empty;
`dateAnchoring=absolute`, `verbatim=shape_conditioned` — confirmed in
the report's provenance header), fresh ingest of the first 50 worlds
(~6.1M haystack tokens; the old worlds were GC'd), vs
`var/lme-50-nolane.json` (80.0%, 2026-07-30). Report
`var/lme-v2smoke.json`, errored=0.

**Paired McNemar: 80.0% → 80.0%, 4 flips each way, p=1.0.** Avg prompt
4685 tokens (baseline era: 4613) — same envelope. The S2 rerank
capability being on did not move the number.

Mid-run incident, fully recovered: the OpenAI org ran out of credits
at 20:39 and `/v1/admin/maintenance/derive` SWALLOWS the 429 (logs a
WARN, returns 201) — 18 worlds went to QA with an empty derived
substrate and checkpointed as legitimate misses (52.2% poisoned
headline). Diagnosed by cross-referencing derive-failed world ids from
the brain log; poisoned rows stripped from the checkpoint; re-derived
after credits auto-recharged; several formerly-"wrong" worlds
re-judged correct. **Carried fix candidate: maintenance/derive should
propagate derive failures (or at least return degraded status) — a
silent 201 on a failed derive is how a poisoned eval row is born.**

<!-- V2EQ2 (LoCoMo corrected leg) RESULT PENDING -->

## V3 — merge + prod (prepared, gated on V2)

- Branch is 116 commits ahead of main, zero behind — fast-forward.
- Migrations riding the merge: **0069-0079** (not just 0079). All are
  exercised live on the 3.1.5 stand by the V2 legs themselves (0076's
  FLEXIBLE-before-TYPE bug was caught and fixed there in the prior
  session; boot smoke aborts the leg on any 5xx).
- 0079 verified: `DEFINE FUNCTION OVERWRITE fn::resolve_fact` with
  namespace-local conflict resolution ($derived_version); the 23-arg
  TS call site ships in the same tree.
- Prod env cleanup committed on the branch (db91ea2) so it ships
  atomically with the merge: deleted `SEARCH_RERANKER_ENABLED=1`,
  `SEARCH_HYPE_ENABLED=1`, `SEARCH_PREDICATE_ROUTER_ENABLED=1`,
  folded `SEARCH_EDGE_EXPANSION_ENABLED=1` (sub-knobs stay), added
  `RETRIEVAL_GENRE=assistant_chat` as intent documentation.
- **Prod behavior deltas to note**: HyPE and the predicate router were
  ON in prod and are deleted from the engine (never measured to a
  verdict in the eval program — prod converges to the measured
  engine). The reranker was already ON in prod, so no invoked-rate
  jump is expected there; the S2 capability fold changes stands that
  had it off, not prod.
- docs/operations.md now documents the RetrievalProfile surface +
  removed keys + the rerank-capability watch guidance (3d0d533).

### V3 executed (2026-08-05)

Main is branch-protected, so the merge went through PR #226 (the
branch's long-lived vehicle, retitled `refactor(platform)`). Unwedging
the branch CI peeled three layers, one of them real:

1. `pnpm-lock` out of sync with the `chrono-node ^2.10.0` manifest
   bump (the event-time work) — install had been failing on the branch
   since July, which is WHY the e2e suite had not run in CI.
2. Four lint leftovers at `--max-warnings 0` (unused import/function/
   directive/binding from the refactor).
3. **A real prod-facing bug the e2e suite caught the moment it ran**:
   the L0 GDPR cascade writes `episodesDeleted`/`segmentsDeleted` into
   the `forgotten_entity` tombstone, but the SCHEMAFULL table never
   got the fields — every forget 500'd. Fixed by migration **0080**;
   all four red e2e suites green.

Merged as 764b6c3 (122 commits, migrations 0069-0080). Auto-deploy
built and shipped the image; the workflow's internal readiness and
external health probes passed, and `https://brain.inite.ai/health`
reports surrealdb ok on the new build.

**Standing watch (operator, ~1 day)**: `brain_search_rerank_total` and
OpenAI spend in Grafana. Expected quiet: prod already ran the reranker
ON, so the capability fold changes nothing there; the real deltas are
HyPE and the predicate router turning off with their deleted code.

## Carried into V4

- `maintenance/derive` must propagate derive failures instead of
  WARN+201 — a silent 201 on a failed derive is how a poisoned eval
  row is born (bit us live this session).
- The audit carry-list unchanged: temporal overlap boost; verbatim as
  a fusion leg in SearchHit; entity-expansion rewrite; releasing the
  scoped connection across LLM awaits; segment/aggregate version
  columns + staging-swap; dreams version-awareness; shrink the S5.2
  env allowlist to one search bootstrap module.
- Candidate: an architecture thesis doc ("memory is a profile of
  capabilities, not a speed") — the genre-law now has measured
  evidence from both directions.
