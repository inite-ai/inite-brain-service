# Measuring the unmeasured flags — inventory and plan (2026-09-11)

179 boolean flags ship default-off. **103 of them appear in no results
document at all**: built, shipped behind a switch, never measured.

The question that started this: *why are we carrying functionality that
measures negative?* Answering it honestly needed two things — the
verdicts we already recorded and never acted on, and an instrument for
the hundred we never measured. The first draft of this page got the
second part wrong, and the correction is the most useful thing on it.

## What is already measured, and lost

Recorded verdicts that were never acted on:

| flag | result | verdict as written |
| --- | --- | --- |
| `DERIVER_DATE_AUDIT` | 73.0 vs 77.8, p=0.0008, temporal −10.3pp | "NEGATIVE, **retire**" ([v11 §13](v11-session-2026-08.md)) |
| `DERIVER_ASPECT_ROLLUPS` | 76.0 (p=0.23), multi-hop −6.3 wrong-way | "NULL/neg — rollups displace atoms" |

Measured null, still carried: `SEARCH_FACT_RERANK` (+0.8pp, p=0.52),
`RETRIEVAL_MENTION_DATES` (+0.5pp, p=0.57), `RETRIEVAL_ENUM_STRICT`
(−0.4pp, p=0.71), `DERIVER_DATE_RESOLVE` (null).

## Why LoCoMo is the wrong instrument for the rest

The first draft routed 17 flags to "paired LoCoMo/LME A/B". That plan
contradicts our own conclusion. [v11 §13](v11-session-2026-08.md):

> **the gpt-4o-mini exhaustive extraction + generation stack is locally
> optimal on the LoCoMo axis.** Eleven interventions across two waves
> (five read-side nulls, three write-side negatives, one policy row, one
> null generator swap, one unfinished) against one real positive.

…with the residual miss mass **63% dataset-capped**. An axis that cannot
move cannot discriminate: running seventeen more legs there predicts
seventeen nulls, and a null on a capped axis is not evidence that a lane
is worthless — it is evidence that we asked a saturated benchmark.

LoCoMo's remaining job is **regression guard**: it tells us a change did
not break the dialogue axis. It is not a discovery instrument, and it is
a single domain (open-domain dialogue), a single situation (fixed-length
sessions, one user, no conflicting updates), and a single question shape.

## What the instruments should be

### 1. More domains — four of six packs have never been run

Six domain packs ship: fintech, medical, legal, HR, insurance,
real-estate. The domain battery installs **two of them** (fintech +
medical), and nothing else exercises the other four at all.

Total mechanical check coverage across every battery we own:

| battery | checks | domain |
| --- | --- | --- |
| `eval:memory-fitness` | 33 | generic dialogue |
| `eval:state-transitions` | 27 | lifecycle/state |
| `eval:domain-packs` | 17 | fintech + medical only |
| `eval:code-memory` | 16 | code |

~93 checks, deciding 100+ flags. All four score **mechanically — no LLM
judge** — so the only cost is the stand's own serving calls. Extending
the domain battery from 2 packs to 6 is the cheapest real increase in
discriminating power we can buy.

### 2. More situations — the batteries are single-shape

Each battery runs one corpus, one session length, one user, one
question shape. The situation axes that actually separate memory systems
are untested: long histories, conflicting updates arriving out of order,
multi-user scope fences, cross-domain entities, and the three input
modes (dialogue / documents / code) against the same subject.

### 3. Traces and statistics — built, and switched off

This is the instrument the flags were supposed to be judged by, and it
has never been connected.

`memory_decision` (0119) records **why the serving path decided what it
decided** — the abstain gate, the L3 escalation trigger, the
fragment-zoom step — with `policyVersion`, `chosenAction`, the
alternatives it rejected, and the observed query class, correlated by
request id and content-free by contract. `memory_outcome` /
`memory_outcome_stat` (0107) record what was retrieved and what was
verified in use. `fact_usage` (0053) records what got surfaced.

**Every one of those is default-off, and `memory_decision` has no read
side at all.** Outside its one writer, every mention of that table is
the GDPR forget cascade or the nightly prune — it writes rows that exist
to be deleted.

So the statistics that would tell us which lanes matter on real traffic
cannot be collected, because the apparatus that collects them is off.
That is the finding, and it reorders everything below.

## Revised plan

1. **Connect the decision/outcome read side and turn the telemetry on.**
   Until this exists, every flag question has to be answered by a
   benchmark rather than by what actually happened. This is the step
   that changes the kind of evidence available.
2. **Extend the domain battery from 2 packs to 6**, then add the
   situation axes above. Mechanical scoring, no judge — cheap.
3. **Retire what is already measured lost** (`DERIVER_DATE_AUDIT`,
   `DERIVER_ASPECT_ROLLUPS`): the verdict is recorded, the decision was
   made in August, only the deletion is missing.
4. **LoCoMo demoted to a regression guard.** Keep it green; stop
   expecting it to discriminate.

## Group 1 result: the consumer graph (13 flags, no eval needed)

A write-side flag whose only consumer is another default-off flag is an
inert plane — both ends shipped, neither connected.

| plane | writer | reader | state |
| --- | --- | --- | --- |
| `memory_outcome` / `_stat` (0107) | `OUTCOME_TELEMETRY_ENABLED` | `search.service.ts:523` under `RETRIEVAL_VERIFIED_USE_DECAY` / `_RANKING` | both ends off |
| `memory_decision` (0119) | `OUTCOME_DECISION_CAPTURE` | **none** | write-only |
| `memory_support` (0116) | `PROVENANCE_SUPPORT_EDGES` | `facts.service.ts` under `PROVENANCE_SUPPORT_GRAPH_READ` | both ends off |
| `fact_usage` (0053) | `SEARCH_USAGE_RECORDING_ENABLED` | `internals/usage.ts:62` under the usage decay/ranking lanes | both ends off |

The first draft of this page proposed deleting them. That was the wrong
call for the first two: they are not dead weight, they are the
measurement apparatus, and the reason they look inert is that nobody
built the consumer. Deleting them would remove the only path to the
statistics the rest of this plan needs.

Consumed after all, and so NOT inert (checked, because the first pass of
this analysis got both wrong): `tool_observation` (0111) is read when
validating a `toolObservationRef` on document ingest, and `audit_event`
feeds the admin audit screen.
