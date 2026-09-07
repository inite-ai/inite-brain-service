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

## Variation axis (`STEV_VARIANT`)

The corpus has three phrasings of the SAME 12 scenarios — same
conversations, same turn counts, same timestamps, same checks
(`variants.ts`, unit-pinned in `test/state-transition-corpus.unit-spec.ts`):

- **`default`** — the original corpus, byte-identical (the builder
  returns the `SCENARIOS` array itself).
- **`paraphrase`** — same facts phrased WITHOUT any verb of the
  deterministic state-verb lexicon (`EXTRACTOR_STATE_VERB_HARVEST`;
  pinned against the exported `STATE_VERB_LEXICON`): "parted with the
  Kawasaki" for sold, "walked away from the chess club" for quit,
  "sent the standing desk back" for returned. Only the transition
  classifier lane (`EXTRACTOR_TRANSITION_CLASSIFIER`: morphology +
  BGE-M3 prototypes) and the LLM extractor can catch these transitions.
- **`ru`** — faithful Russian phrasings («продал», «вернул»,
  «вступил», «записался», …; person names go Cyrillic, brand names
  stay Latin the way Russian text writes them), exercising the RU
  prototype path of the classifier and the RU candidate matcher's
  sentence-scoped guards — including the documented deliberate-miss
  class («Я продал Kawasaki сегодня; байка больше нет.» is ONE guarded
  span, because the RU guard is sentence-scoped and `sentenceSpans`
  splits only before Latin uppercase).

Check expectations stay the same across variants: nothing is removed,
marker lists only gain language/phrasing alternates a correct answer
would legitimately echo (a served «вернул» is as correct as
'returned'), and provenance fragments are re-authored to quote the
variant's own turns verbatim. The honest framing: **variants measure
extraction ROBUSTNESS across phrasings and languages, not pass/fail
parity** — a paraphrase or RU run scoring below default is a
measurement of where the classifier/LLM lanes go blind, not a battery
regression, and the deltas between the three scorecards are the
deliverable.

Use a fresh run (fresh salted user) per variant; comparing variants on
one tenant is fine because runs are user-scoped and hermetic.

## Expected fails on today's code (the baseline IS the point)

Three checks are **expected to fail** on current `main` (default flags)
and are annotated `knownFailToday` in `scenarios.ts` (the belief pair is
tracked as #135; the scorecard counts them separately, and the runner
prints `(expected today)` next to them):

- **s01-belief** — `SCENES_BELIEF_NEGATION_DELTAS`: a disposal ("no bike
  anymore") does not reliably emit a stateDelta, so the belief stays at
  the acquisition revision instead of flipping to a none-ish value with
  the Kawasaki as `priorValue`.
- **s08-belief** — `SCENES_BELIEF_FIELD_FOLD`: "home city" and "place of
  residence" fold into different free-text field keys, so no single
  belief carries `value` + `priorValue` across the drifted wording.
- **s07-serve** — `CONFLICT_SLOT_CANONICALIZATION`: the two arms extract
  into DIFFERENT slots on one entity — `(office lease, status)` = "ends
  in September 2026" vs `(office lease, duration_limit)` = "until
  December 2026" (measured live) — and the conflict machinery pairs only
  identical `(userId, entity, predicate)`, so even with
  `CONFLICT_MENTION_FACT_SLOT` on no collision structurally exists. The
  flag (default off) routes the calendar-anchored `duration_limit` arm
  into the canonical `status` slot at write time so the pair meets in
  one slot and the `bitemporal` margin doctrine (which
  `CONFLICT_MENTION_FACT_SLOT` applies there) can compete it.

The battery still RUNS these checks and records their fails — that is
the baseline those flags, once merged and enabled, are measured against.
A run where they pass is the signal the bugs are fixed.

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
- `CONFLICT_MENTION_FACT_SLOT=1` — the flag the **s07-serve** expected
  fail exists to validate: mention-path extraction resolves the lease
  slot to `single_active` semantics, whose resolver branch supersedes
  unconditionally and never forms the COMPETING pair, so serving picks
  one side of the contradiction. With the flag on, the slot is promoted
  to `bitemporal` margin doctrine and the close-scored pair COMPETES
  (both sides served or an honest abstain).

Then:

```bash
BRAIN_BASE_URL=http://localhost:3000 \
BRAIN_API_KEY=<tenant M2M key: brain:read + brain:write [+ brain:admin]> \
BRAIN_COMPANY_ID=<fresh tenant id> \
pnpm eval:state-transitions
```

Optional env: `STEV_VARIANT` (`default` | `paraphrase` | `ru`, default
`default` — see the variation axis above), `STEV_USER_ID` (default
`stev-agent-<runId>`, run-salted per #457), `STEV_RUN_ID` (defaults to
a fresh id), `STEV_GUARDRAILS` (`strict` | `lenient` | `off`, default
`strict`), `STEV_SKIP_INGEST=1` (re-ask an already-ingested run; pass
the same `STEV_RUN_ID` AND the same `STEV_VARIANT`), `STEV_REPORT_DIR`
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
