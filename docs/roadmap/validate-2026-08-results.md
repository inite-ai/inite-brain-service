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

## Carried into V4 — EXECUTED (2026-08-05, feat/engine-v4-carried)

All eight carried items landed as one PR-sized branch, each with unit
coverage and the six gates green:

- `maintenance/derive` propagates failures: DeriveRunResult grows
  `status`/`failed`, total failure → registry `failed` + HTTP 502,
  activation requires a clean run, and the eval driver refuses to QA
  any non-ok derive (rows error instead of checkpointing).
- Temporal overlap boost: profile key `RETRIEVAL_TEMPORAL_MODE`
  (`filter` default | `overlap_boost` — validity closure relaxed,
  Hindsight-style interval-overlap decay in scoring).
- Verbatim as a fusion leg: `RETRIEVAL_VERBATIM_EVIDENCE=fused` —
  segments retrieved inside the pipeline through the same convex
  fusion, scored, reranked, citable as SearchHits; the appendix lane
  stays byte-identical under `always`.
- Entity-expansion second retrieval: profile key
  `RETRIEVAL_ENTITY_EXPANSION` (default off) — top discovered entity
  names anchor one more legs+fusion pass before scoring.
- Scoped connection released across LLM awaits: the pipeline is now
  runDbStages (inside the pool slot, ends by prefetching rerank
  neighbourhoods) + rankAndAssemble (cross-encoder + LLM rerank +
  assembly, connectionless).
- Segments/aggregates: atomic staging-swap (paid calls before any
  delete; delete+insert in one transaction), migration 0081 adds the
  per-run `generation` stamp on episode_segment.
- Dreams version-aware: every leg (dedup, resolve, corroborate,
  communities) fenced to the tenant's live derived world via
  ReadPinService + the new shared `derivedVersionFence()`.
- S5.2 env allowlist = exactly one module: `retrieval-profile.ts`
  (new `resolveSearchTuning()` snapshot in the PipelineContext; legs'
  import-time SQL constants became per-call; derived-version fallbacks
  route through `ReadPinService.bootstrapDefault()`).

The architecture thesis doc shipped as
[docs/architecture-manifest.md](../architecture-manifest.md) ("memory
is a profile of capabilities, not a speed") — draft, pending owner
review.

None of the new profile points (overlap_boost / fused /
entityExpansion) are default-on: defaults are byte-identical to V3
prod, and each is a measured-leg candidate for the next eval session.

## V4 confirm legs (2026-08-05, same day, read-side re-QA)

All four axes ran as paired A/B chains on the SURVIVING stand
substrates (loco-321; no re-ingest, no re-derive — read-side only):
control arm = merged-main defaults, treatment arm = one new profile
point. Controls double as defaults-equivalence checks against the
pre-merge reports. Judge gpt-4.1-mini throughout; McNemar pairing.

| Axis (substrate) | Control | Treatment | Verdict |
|---|---|---|---|
| LME temporal 233-365 (n=127 judged) | **40.2%** vs ewave-era 30.7% (+9.4pp, p=0.004) | overlap_boost **41.7%** (+1.6pp, p=0.73) | see below |
| LME SSA 444-499 (n=56) | 48.2% | fused **41.1%** (−7.1pp, p=0.50; prompt 4.9k→11.1k tok) | fused NOT viable vs shape_conditioned as tuned |
| LME SSU first-50 (n=50) | 82.0% vs v2smoke 80.0 (p=1.0) | entityExpansion 80.0% (p=1.0) | no harm; wrong genre (MS worlds are gone — real target unmeasured) |
| LoCoMo dev-5 (n=762 judged) | 'always' **76.8%** vs v2eq2 76.6 (p=1.0) | fused **78.2%** (+1.4pp, p=0.27; single-hop +2.6 p=0.08; prompt 5745→5550 tok) | fused ≥ always on diary, CHEAPER |

Findings:

1. **The V2/V3 read-path wave was worth +9.4pp on LME temporal**
   (30.7 → 40.2, p=0.004, 14↑/2↓). The ewave-era baseline predates the
   W4/W5 read-path fixes (local cross-encoder default-ON, fact-centric
   layered over the rerank order, verifier bundle); this is the first
   paired measurement of that stack on the weakest LME type. Not a V4
   effect — V4 defaults are equivalence-clean on all three other axes
   (p=1.0 twice, +0.1pp once).
2. **overlap_boost is safe and mildly positive on its target type**
   (+1.6pp temporal, n.s., no collapse from the relaxed closure — the
   feared soft-recall poisoning did not materialize). Needs bigger n
   for a claim; stays default-off.
3. **'fused' is genre-split exactly as the capability-profile thesis
   predicts**: on assistant chats vs shape_conditioned it is additive
   cost (2.3× prompt) with noisy-negative drift (−7.1pp n.s.); on the
   diary profile vs 'always' it is nominally better (+1.4pp, single-hop
   +2.6 at p=0.08) AND cheaper (−200 avg prompt tokens), because
   segments compete for the fact budget instead of riding as an
   unconditional appendix. Candidate: make 'fused' the diary-profile
   default after a held-out confirm; never a shape_conditioned
   replacement without a segment token cap.
4. **entityExpansion remains unmeasured on its target genre** — the
   multi-session worlds no longer exist on the stand (0/133); the
   SSU smoke shows no harm (p=1.0). A real MS leg needs a paid
   re-ingest.

Reports: var/lme-tr-v4{control,boost}.json,
var/lme-ssa-v4{control,fused}.json, var/lme-ssu-v4{control,exp}.json,
var/locomo-v4{always,fused}-dev5.json (checkpoints alongside).

## V5 legs (2026-08-05/06, same session): held-out record pair + MS + capped fused

Paid substrate built: LoCoMo HELD-OUT 5 (tenant locov5, diary write
profile verified against the catalog, 2040 wd-v2 propositions) and 50
LME multi-session worlds (episode-only ingest + derive). Two live
bugs caught by the legs and fixed en route: operator_action audit
writes bound JS null into option<> fields (every audited maintenance
call 500'd on 3.x — PR #249), and the first fused cut ignored
segmentTopK (PR #247).

| Pair | Result |
|---|---|
| Held-out 'always' vs E16-era record | **78.6%** nominal (record-class substrate reproduced) |
| Held-out fused-capped vs always | **78.7%** (+0.1pp, p=1.0) at **−8% prompt tokens** (5367 vs 5836) |
| LME MS control vs entityExpansion (n=49) | 26.5% → **32.0%** (+5.5pp, 5↑/3↓, p=0.73) |
| LME SSA shape_conditioned vs fused-CAPPED (n=56) | 48.2% → **55.4%** (+7.1pp, 13↑/9↓, p=0.52; tok 4.9k→8.6k) vs uncapped 41.1% at 11.1k |

Verdicts (quality rule: non-negative pair → default candidate):

1. **'fused' (capped) is the new diary-profile recommendation** —
   equal held-out quality to 'always' at −8% tokens, segments citable,
   one fusion doctrine. Nominal 78.7 ties the E16 held-out record.
2. **The segmentTopK cap flipped fused's sign on assistant chats**
   (−7.1pp uncapped → +7.1pp capped vs shape_conditioned, both n.s.):
   too many segments drowned the facts, top-K helps. Default stays
   shape_conditioned pending a bigger-n confirm; fused-capped is now a
   measured-positive candidate on BOTH genres.
3. **entityExpansion measured on its target genre at last**: +5.5pp
   nominal on MS, no harm, negligible token cost. The 50-world MS
   substrate persists on the stand for a full-block confirm.

Reports: var/locomo-v5ho-{always,fused}.json, var/lme-ms-v5{control,exp}.json,
var/lme-ssa-v5fusedcap.json.

## V6 legs (2026-08-06/07): second-genre confirms + W3 write tract + V7 points

Session brief: docs/roadmap/next-session-v5-2026-08.md §2-3 remainder
(W3 write tract, BEAM overlap_boost, full MS block, bigger-n
fused-capped), extended in-session with the V7 profile points and an
aggregates leg. Substrates: surviving loco-321 worlds (BEAM 20
tenants, 290 LME worlds), paid MS remainder ingest (83 worlds), and a
fresh-tenant LoCoMo dev-5 (locow3d) under the W3 write code. Brains
for read-side legs = merged-main dist (a629429); W3 confirm =
feat/w3-write-tract via ts-node. Judge gpt-4.1-mini; McNemar pairing.

Infra incidents (all recovered, no poisoned rows — derive/ingest are
fail-loud since V4): loco-321 OOM'd twice (three concurrent chains,
then the registry storm below); OpenAI credits ran dry mid-MS
(refilled, resumed from checkpoints); a workspace-level pnpm install
broke the repo's hoisted node_modules (--ignore-workspace is the repo
idiom); /tmp datasets were reaped twice (re-fetched per the crib); the
brain's own ThrottlerException 429'd the accelerated LoCoMo ingest
(THROTTLE_DISABLED=1 is the sanctioned eval-stand switch — hardcoded
per-route @Throttle decorators ignore the env limits).

| Pair | Result |
|---|---|
| BEAM full-400 control (merged main, B0 profile) vs B0-era 35.3% | **36.9%** judged (n=360) — read-path equivalence on genre #3 |
| BEAM temporal_reasoning control vs overlap_boost (n=40) | 27.5% → **32.5%** (+5.0pp, 3↑/1↓, p=0.63); overall +1.0pp p=0.56 |
| LME TR shape_conditioned vs fused-capped (n=133) | 40.2% → **33.1%** judged (−7.1pp, 25↓/16↑, p=0.21) at 4.6k→12.4k tok |
| LME SSU shape_conditioned vs fused-capped (n=50) | 82.0% → **72.0%** (−10.0pp, 9↓/4↑, p=0.27) at 10.3k tok |
| LME 3-block pooled fused-capped (n=239) | 51.9% → **46.9%** (−5.0pp, 46↓/34↑, p=0.22) |
| LME MS full-block control vs entityExpansion (n=133) | 52.9% → **52.9%** judged (5↑/5↓, p=1.0) |
| LoCoMo dev-5 W3-write vs var/locomo-v4always-dev5 (n=762) | 76.8% → **77.0%** (+0.3pp, 58↑/56↓, p=0.93); substrate 1837 props, segments 1286 (bit-identical to the E9 count) |
| LME MS control vs +aspect aggregates in wd-v2 (n=133) | 52.9% → **52.9%** judged (1↑/1↓, p=1.0) |
| BEAM control vs +aspect aggregates (n=400) | 37.8% → **35.7%** overall (−2.0pp, 17↓/9↑, p=0.17); summarization 20.0→12.5 (3↓/0↑) |

Findings:

1. **overlap_boost has its second genre**: BEAM temporal_reasoning
   +5.0pp (n.s.) mirrors LME temporal +1.6pp (n.s.) — mildly positive
   on the target ability in BOTH genres, no collapse anywhere.
   Watch-item: BEAM summarization −7.5pp (3↓/0↑, p=0.25) under the
   relaxed closure. Stays default-off; a measured-safe profile point
   for temporal-heavy workloads.
2. **fused-capped is NOT a shape_conditioned replacement**: pooled
   −5.0pp at n=239. The split is by QUESTION CLASS, not tenant:
   SSA +7.1 / SSU −10.0 / TR −8.3 — segments pay exactly when the
   answer lives in assistant verbatim turns and drown facts everywhere
   else. This produced the 'routed' profile point (PR #252):
   verbatim-shaped → fused, else shape_conditioned. (The first routed
   cut keyed on timeline shape; the SSU leg falsified it same-day.)
   The diary-profile fused-capped recommendation (V5) is unaffected.
3. **entityExpansion is a null result at full n**: the V5 +5.5pp on
   n=49 did not replicate (exact tie at n=133). No harm, no gain;
   default-off, no longer a candidate.
4. **W3 write tract confirmed and merged** (PR #251): the fresh-tenant
   pair is equivalence-clean (+0.3pp, p=0.93) with the substrate
   reproducing the lineage counts — the alias column, append_only
   default for coined predicates, and append_only corroboration are
   the default write behavior now. En route the leg caught a live
   O(n²) registry storm (canonicalize invalidated the snapshot per
   novel coinage; repeat proposed coinages re-embedded + re-inserted
   every time) — fixed in the same PR with a regression spec; the leg
   also surfaced the pre-existing operator_action `ts` datetime
   coercion WARN on 3.x (unfixed, carried).
5. **Naive aggregates-in-the-derived-world is a measured null**
   (Hindsight's "observations" thesis, unqualified version): composing
   aspect aggregates into wd-v2 on MS (tie) and BEAM (−2.0pp drift,
   summarization down) shows retrievable summaries DILUTE the fact
   budget without a dedicated arbitration slot. The qualified version
   — an insight lane with its own budget, mirroring the fused segment
   leg — is V8 material. Substrate note: the MS and BEAM wd-v2 worlds
   now permanently carry aggregate rows
   (source.recorder='aggregate-composer-v1'); future pairs on these
   stands inherit them.

V7 profile points merged same-session (PR #252, all default-off,
defaults byte-identical): RETRIEVAL_VERBATIM_EVIDENCE=routed
(verbatim-shape dispatch), the 1200-char per-segment prompt budget,
the deriver finish_reason truncation guard, and
DERIVER_COMPLETION_PASS (ewave: needs a fresh-derivedVersion confirm
before any default claim; the routed SSA arm is the other open leg).

Reports: var/beam-100k-v6{ctl,boost,agg}.json,
var/lme-tr-v6fusedcap.json, var/lme-ssu-v6fusedcap.json,
var/lme-msfull-{control,exp,agg}.json, var/locomo-w3d-dev5.json
(checkpoints alongside).
