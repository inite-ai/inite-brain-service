# State-transition battery

Mechanical sibling of [`test/eval/memory-fitness`](../memory-fitness/README.md),
aimed at ONE claim instead of eight dimensions: **memory tracks a mutable
world-state** — a belief flips to the current value while keeping its
`priorValue` and `revision`, superseded facts survive as history, and
serving answers with current truth, not with whatever was written first.

Where memory-fitness measures general first-person memory fitness over
one interleaved corpus, this battery seeds 12 isolated **state-transition
scenarios** (each with its own entity, so scenarios cannot
cross-contaminate) and executes 2-4 typed checks per scenario. Ground
truth is authored WITH the turns, so grading is self-contained and free:
**no LLM judge, no paid eval** — the only model spend is the stand's own
serving cost.

## Scenario taxonomy

| #   | Scenario                 | Class                | What would falsify the claim                                 |
| --- | ------------------------ | -------------------- | ------------------------------------------------------------ |
| s01 | dispose                  | dispose              | "no bike anymore" not reflected; belief stuck at acquisition |
| s02 | replace                  | replace              | old laptop served as current; history loses a stage          |
| s03 | re-acquire               | re-acquire           | join → quit → rejoin collapses; final state wrong            |
| s04 | retro-dated              | retro-dated          | a cancellation reported late is not current truth            |
| s05 | intention-not-action     | non-transition-guard | "thinking about selling" flips ownership                     |
| s06 | listed-not-sold          | non-transition-guard | listing for sale treated as a disposal                       |
| s07 | contradiction            | conflict             | one side of a live conflict served silently                  |
| s08 | field-drift              | field-drift          | "home city" vs "place of residence" split the belief key     |
| s09 | third-party              | third-party          | Boris's transition misattributed to the speaker              |
| s10 | same-day                 | same-day             | two intra-day transitions collapse or reorder                |
| s11 | multi-object             | multi-object         | selling one of two objects loses (or keeps) the wrong one    |
| s12 | provenance-of-transition | provenance           | the flip is asserted without unrolling to the seeded turns   |

## Check kinds (all mechanical — see `types.ts` / `scorers.ts`)

- **`serve`** — MCP `synthesize` (strict guardrails by default) scored by
  `expectAnyOf` / `forbidAnyOf` / conflict-sides / expect-abstain.
  Scoring is **marker-first**: the honest answer to a disposal question
  ("you don't have a bike anymore") trips the shared decline regex
  (`test/eval/abstain.ts`), so abstention alone never fails a serve
  whose expected truth IS a negation; expect markers are authored to
  never occur in decline phrasings (`'sold'`, `'no longer'` — never bare
  `'no'` / `'do not'`).
- **`belief`** — `GET /v1/beliefs?userId=…`: a belief matching the
  free-text (subject, field) token filters carries the expected `value`,
  `priorValue` and `revision` depth.
- **`fact-history`** — `search_knowledge` → `get_entity_timeline`: the
  timeline retains every transition stage as `fact.recorded` events, as
  a chronological subsequence (the sibling's `checkEvolution`,
  generalised to N stages and LLM-worded predicates).
- **`provenance`** — `search_knowledge` → `get_fact_provenance`: a fact
  about the transitioned state unrolls to an episode quoting a seeded
  fragment verbatim (the sibling's `walkProvenance`, with its
  round-robin candidate interleave).

Score = per-scenario pass (ALL of its checks pass) plus a per-check-kind
tally; the scorecard groups scenarios by class.

## Expected fails on today's code (the baseline IS the point)

Two belief checks are **expected to fail** on current `main` and are
annotated `knownFailToday` in `scenarios.ts` (tracked as #135; the
scorecard counts them separately, and the runner prints
`(expected today)` next to them):

- **s01-belief** — `SCENES_BELIEF_NEGATION_DELTAS`: a disposal ("no bike
  anymore") does not reliably emit a stateDelta, so the belief stays at
  the acquisition revision instead of flipping to a none-ish value with
  the Kawasaki as `priorValue`.
- **s08-belief** — `SCENES_BELIEF_FIELD_FOLD`: "home city" and "place of
  residence" fold into different free-text field keys, so no single
  belief carries `value` + `priorValue` across the drifted wording.

The battery still RUNS both checks and records their fails — that is the
baseline those flags, once merged and enabled, are measured against. A
run where they pass is the signal the bugs are fixed.

## Running against a local stand

Same stand as the sibling: a booted brain (with its OpenAI key), driven
purely over the wire — **never run in CI** (the runner exits with a
clear message when `BRAIN_BASE_URL` is unset).

Stand flags that shape coverage:

- `FACTS_API_ENABLED=1` — required for the provenance checks
  (`get_fact_provenance` is otherwise absent; those checks are skipped).
- `THROTTLE_DISABLED=1` — recommended: mention ingest and the MCP route
  are rate-capped; without it the runner backs off on 429.
- For the belief checks: `SCENES_SEGMENTATION_ENABLED=1`,
  `SCENES_LLM_ENRICHMENT=1`, `SCENES_FACT_BACKLINK=1`,
  `SCENES_BELIEF_PROMOTION=1`, `BELIEFS_API_ENABLED=1`, and an API key
  with `brain:admin` (the belief build runs in-band). Without them the
  belief checks are skipped, never silently passed.
- Once #135 lands: `SCENES_BELIEF_NEGATION_DELTAS=1` and
  `SCENES_BELIEF_FIELD_FOLD=1` are the flags this battery's expected
  fails exist to validate.

Then:

```bash
BRAIN_BASE_URL=http://localhost:3000 \
BRAIN_API_KEY=<tenant M2M key: brain:read + brain:write [+ brain:admin]> \
BRAIN_COMPANY_ID=<fresh tenant id> \
pnpm eval:state-transitions
```

Optional env: `STEV_USER_ID` (default `stev-agent`), `STEV_RUN_ID`
(defaults to a fresh id), `STEV_GUARDRAILS` (`strict` | `lenient` |
`off`, default `strict`), `STEV_SKIP_INGEST=1` (re-ask an
already-ingested run; pass the same `STEV_RUN_ID`), `STEV_REPORT_DIR`
(default `var/state-transitions/`).

Conversation ids are run-scoped (`<runId>-s01a`), so re-runs never
collide on conversations; as with the sibling, use a **fresh
`BRAIN_COMPANY_ID` per scored run** so the fact substrate stays a single
clean write history.

## Cost

One run ingests **52 mention turns** (each runs mention extraction on
the stand's LLM) and makes **13 `synthesize` calls**, plus the free
read-side calls (search / timeline / provenance / beliefs). Roughly the
same order of spend as a memory-fitness run (66 turns + its question
set); judging costs nothing.

## Output

- A human scorecard on stdout: per-class scenario tally, per-kind check
  tally, overall scores, and the count of fails that were expected on
  today's code.
- A JSON report at `var/state-transitions/state-transitions-<runId>.json`
  (gitignored) with per-check status, detail, latency, raw served
  answers, and the `knownFailToday` annotations — every verdict is
  reproducible from the report plus `scorers.ts` (unit-tested in
  `test/state-transition-scorers.unit-spec.ts`; the reused generic
  scorers are covered by the sibling's spec).
