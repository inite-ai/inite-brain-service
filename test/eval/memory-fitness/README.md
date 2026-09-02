# Memory-fitness harness

First-person memory fitness for the brain: **imagine the brain is YOUR
memory and you write into it — the most eloquent test is whether it
works as memory.** This harness is not benchmark-QA over synthetic
diaries. It writes one engineering agent's OWN working knowledge through
the real wire (MCP Streamable HTTP + REST), then asks the questions the
same agent would genuinely ask weeks later, and scores mechanically.

Ground truth is authored WITH the corpus (`corpus.ts` and `questions.ts`
are written together), so grading is self-contained and free: **no LLM
judge, no paid eval**. The only model spend is the stand's own normal
serving cost (mention extraction on ingest, synthesis on questions).

## The eight dimensions

| Dim | Name                      | What it measures                                                                                                           | Mechanical check                                                                 |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D1  | State currency            | A revised decision serves the CURRENT value, and the stale value does not leak                                             | expected substring present, forbidden (stale) substring absent                   |
| D2  | Evolution history         | Superseded state is retained, not garbage-collected: old + new both in history, in order                                   | entity timeline (and, optionally, promoted belief `value` + `priorValue`)        |
| D3  | Provenance unrollability  | A served claim unrolls to ≥1 verbatim episode quoting the seeded turn                                                      | `get_fact_provenance` walk, substring match against corpus fragments             |
| D4  | Temporal anchors          | Dated decisions come back with their dates                                                                                 | date matcher over common phrasings of the expected `yyyy-mm-dd`                  |
| D5  | Absence honesty           | Never-written topics yield abstention, not confabulation                                                                   | `answer === null` or the shared decline regex (`test/eval/abstain.ts`)           |
| D6  | Conflict surfacing        | Two disagreeing sources are surfaced, not silently collapsed to one                                                        | `get_competing_facts` lists both sides; the served answer names both or abstains |
| D7  | Cross-session integration | Questions answerable only by joining two conversations                                                                     | `search_multi_hop` (fallback `synthesize`), expected substring                   |
| D8  | Self-utility replay       | Questions phrased exactly as a returning agent asks them ("what idiom do we use for X and why", "which numbers are taken") | key-phrase presence                                                              |

## The corpus

`corpus.ts` seeds 66 first-person mention-turns across 5 conversations
(2026-03-02 … 2026-04-02) for one primary user: an engineering agent
("Argus") building `ledger-sync`. Engineered into the text:

- **four revision chains** — queue backend (Redis Streams → NATS
  JetStream), retry policy (fixed 3×30s → exponential backoff cap 5),
  pilot launch (2026-04-15 → 2026-05-06), deploy target (Fly.io → AWS
  ECS Fargate);
- **stable facts** — repo, ports 8443/9464/8081, staging namespace,
  flag prefix, dashboard name, Meridian sandbox rate limit;
- **one contradiction pair** — Meridian payout cutoff: Priya says
  17:00 UTC, Meridian docs v2.3 say 16:30 UTC (deliberately left
  unresolved);
- **temporal anchors** — every decision carries its date in the text;
- **cross-conversation entities** — Meridian, Priya, `ls-staging`;
- **grounding mix** — 12 direct `record_fact` calls carrying both
  `evidence[]` and `conversationId`, 3 deliberately ungrounded.

## Running against a local stand

The harness needs a booted brain (with its OpenAI key) and drives it
purely over the wire — it is **never run in CI** (the runner exits with
a clear message when `BRAIN_BASE_URL` is unset).

Stand flags that shape coverage:

- `FACTS_API_ENABLED=1` — required for D3 (`get_fact` /
  `get_fact_provenance` tools are otherwise absent; D3 is then skipped).
- `THROTTLE_DISABLED=1` — recommended: mention ingest is capped at
  10/min and the MCP route at 30/min; without the flag the runner
  backs off on 429 and a run takes much longer.
- Optional, for the D2 belief leg: `SCENES_SEGMENTATION_ENABLED=1`,
  `SCENES_LLM_ENRICHMENT=1`, `SCENES_FACT_BACKLINK=1`,
  `SCENES_BELIEF_PROMOTION=1`, `BELIEFS_API_ENABLED=1`, and an API key
  with `brain:admin` (enrich runs in-build during the scenes pass).
  Without them the belief question is skipped, never silently passed.

Then:

```bash
BRAIN_BASE_URL=http://localhost:3000 \
BRAIN_API_KEY=<tenant M2M key: brain:read + brain:write [+ brain:admin]> \
BRAIN_COMPANY_ID=<fresh tenant id> \
pnpm eval:memory-fitness
```

Optional env: `MEMFIT_USER_ID` (default `memfit-agent`),
`MEMFIT_RUN_ID` (defaults to a fresh id), `MEMFIT_GUARDRAILS`
(`strict` | `lenient` | `off`, default `strict` — strict is the honest
test: the brain must ground what it serves), `MEMFIT_SKIP_INGEST=1`
(re-ask an already-ingested run; pass the same `MEMFIT_RUN_ID`),
`MEMFIT_REPORT_DIR` (default `var/memory-fitness/`).

### Idempotent re-runs

Every conversation id is prefixed with the run id, so re-runs never
collide on conversations. Facts, however, accumulate per tenant: a
second full run re-asserts the same facts into the same graph (the
conflict resolver dedups/supersedes, so scores usually hold, but the
substrate is no longer a single clean write history). **Recommended:
a fresh `BRAIN_COMPANY_ID` per scored run** — the tenant is the
namespace, and it is operator-supplied on purpose. To re-ask questions
without re-writing, use `MEMFIT_SKIP_INGEST=1` with the original
`MEMFIT_RUN_ID`.

## Output

- A human scorecard on stdout: per-dimension pass/fail/skipped, overall
  score over the scored (non-skipped) questions, median/max per-question
  latency.
- A JSON report at `var/memory-fitness/memory-fitness-<runId>.json`
  (gitignored) with per-question status, detail, wall-clock latency,
  and the raw served answers — every verdict is reproducible from the
  report plus `scorers.ts`.

`skipped` is an explicit verdict, reserved for stand preconditions the
run could not satisfy (flag off, missing scope) — a skipped question is
reported, never counted as a pass.

## Self-graded philosophy

The corpus and the expectations are one artifact: whoever writes the
memory writes the answer key. That keeps grading mechanical
(substring / date / regex / chain-walk — see `scorers.ts`, unit-tested
in `test/memory-fitness-scorers.unit-spec.ts`) and free of judge bias:
no paid judge, no rubric drift, and any scoring dispute is settled by
reading the seeded turn the expectation points at. The trade-off is
narrowness — this harness measures whether the brain works as ONE
agent's memory on an authored history; it complements, not replaces,
the benchmark axes under `test/eval/`.
