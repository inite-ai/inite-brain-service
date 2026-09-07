# Code-memory battery

Fourth mechanical battery, sibling of
[`test/eval/memory-fitness`](../memory-fitness/README.md) (general
first-person memory fitness),
[`test/eval/state-transitions`](../state-transitions/README.md) (memory
tracks a mutable world-state) and
[`test/eval/domain-packs`](../domain-packs/README.md) (memory with
installed industry packs). This one isolates the dogfood claim: **a
coding agent's turns about its own repo become recallable, current,
provenance-clean code memory.**

Two things make it different from the domain-pack sibling:

- **The pack under test is BUILTIN.** `code_memory` is never installed —
  bootstrap seeds its predicates into every tenant and the install path
  REJECTS the builtin id by design (`domain-pack-install.service.ts`),
  so phase 0 performs **no install**: it reads `GET /v1/admin/predicates`
  and check `k01` asserts the four namespaced predicates are active.
  The absence of an install step is itself under test.
- **The battery is findings-first by construction.** Half the checks
  measure gaps the code-memory audit ranked (no extractionProfile, the
  0.4.0 ontology increment, coding transition verbs, artifact holder
  binding) — they are annotated `expectedUnknown` and their fails are
  the recorded gaps, never regressions. See the honesty policy below.

## The corpus

One userId (`cm-agent`), ~20 turns of realistic coding-agent narration
about a FICTIONAL repo, **"acme-api"**, in four conversations:

| conversation | seeds                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `decision`   | a dispatch decision + its rationale, an invariant (zod schemas), a gotcha (dry-run takes the schema lock), then a SUPERSEDING decision                                         |
| `flags`      | `ACME_RETRY_QUEUE` introduced dark (default 0), the literal lane's prose (port 9187, 120 req/min), the SYMBOL phrasing of the shared module, then the flag enabled (default 1) |
| `deps`       | `redis-client` pinned 1.2.0 → bumped 2.0.0, module ownership (Priya owns src/gateway), a gotcha bound to the new version, a second pinned dep                                  |
| `mixed`      | PR #212 merged then REVERTED, two voiced-plan turns about `ACME_STRICT_MODE` that must NOT flip state, a postmortem line                                                       |

One module — `src/gateway/webhook-dispatcher.ts` aka
`WebhookDispatcher` — is referenced by PATH in one conversation and by
SYMBOL in another, so entity identity is measured, not assumed (the
runner deliberately passes NO `knownEntities` hints).

Scoreability rules inherited from the siblings: transition turns never
restate the old value; provenance fragments appear verbatim in exactly
one turn under the 600-char cap; numeric literal markers (9187, 120)
are unique to one turn; every `ACME_STRICT_MODE` turn is a voiced plan.

## Check battery (all mechanical — see `types.ts` / `scorers.ts`)

| id  | kind              | gap-gated | What would falsify the claim                                                                                                                      |
| --- | ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| k01 | builtin-vocab     |           | the builtin `code_memory__*` predicates are NOT active in a fresh tenant (bootstrap seeding broken)                                               |
| k02 | pack-vocab        | yes       | the dispatch decision coins an open-vocab predicate instead of `code_memory__decided`                                                             |
| k03 | pack-vocab        | yes       | the zod invariant misses `code_memory__invariant`                                                                                                 |
| k04 | pack-vocab        | yes       | the dry-run trap misses `code_memory__gotcha`                                                                                                     |
| k05 | pack-vocab        | yes       | the flag default has no typed `code_memory__default_value` home (arrives with pack 0.4.0)                                                         |
| k06 | pack-vocab        | yes       | the dependency bump has no typed `code_memory__depends_on_version` home (arrives with pack 0.4.0)                                                 |
| k07 | literal-harvest   |           | the ALL_CAPS flag / port / rate limit in coding prose produce no `identifier` / `service_port` / `rate_limit`                                     |
| k08 | flag-transition   | yes       | no single entity timeline retains introduced-dark → enabled in order (needs the coding-verb lexicon; holder binding routes the flip to the agent) |
| k09 | supersession-asof |           | re-`decided` leaves TWO active decisions, or the old one is unrecoverable at `asOf`, or `asOf` leaks the future                                   |
| k10 | cross-entity      |           | the module referenced by path vs symbol splits into two entities, or a phrasing's facts never attach to the one module (identity only: the marker scan is predicate-agnostic over ALL the entity's facts — slotting is k02-k06 scope) |
| k11 | trace-provenance  |           | the decision fact does not unroll to the seeded turn's episode verbatim                                                                           |
| k12 | serve             | yes       | "current default of ACME_RETRY_QUEUE" serves the stale 0/disabled or abstains — the dogfood north-star                                            |
| k13 | serve             | yes       | "who owns src/gateway" cannot name Priya (ownership has no typed home until 0.4.0 `owns`)                                                         |
| k14 | intention-guard   |           | a voiced plan produced a completed `state_change` naming `ACME_STRICT_MODE` — must stay green before AND after the coding-verb lexicon lands      |
| k15 | mcp-roundtrip     |           | `record_decision` → `why` on a fresh anchor does not round-trip                                                                                   |
| k16 | no-rogue-tools    |           | tools/list exposes a `__`-namespaced pack tool (the code-memory tools are core single-underscore names)                                           |

Scoring reuses the siblings' unit-tested primitives (`containsAnyOf`,
`isAbstention`, `walkProvenance`, `checkHistorySequence`, `scoreServe`,
`findExactPredicateFact`, `findNamespacedTools`,
`interleaveRoundRobin`) — one implementation, one truth — and adds only
the code-memory scorers, unit-tested in
`test/code-memory-scorers.unit-spec.ts`. **No LLM judge, no paid eval**
— the only model spend is the stand's own extraction + serving cost
(~20 mention extractions + 2 synthesize calls per run).

## Honest-baseline policy (`expectedUnknown`)

The domain-pack battery's pattern, extended: a check whose outcome
depends on work that has not landed carries an `expectedUnknown`
annotation. The runner still EXECUTES it, the report records the exact
failure shape (e.g. which coined predicates swallowed the value), the
scorecard tallies these fails separately (`failedExpectedUnknown`) and
prints the gap-gated id list — **a fail there is the finding, a pass is
the measured signal the parallel PR landed.** The gates:

- **k02-k04** — `code_memory` ships no `extractionProfile` (the only
  pack without one), so mention-path phrasing has never canonicalized
  into its vocabulary. Flips when the pack 0.3.0 extraction-profile PR
  lands.
- **k05, k06, k12, k13** — target the pack **0.4.0** ontology increment
  (`default_value`, `depends_on_version`, `owns`; `superseded_by` is
  exercised mechanically by k09's single_active semantics instead of a
  vocab check). The annotation is COMPUTED from the live manifest
  (`gap040` in `corpus.ts`): while the predicate is absent the check
  says it cannot pass yet; the moment 0.4.0 merges, the annotation
  self-softens to "never measured" with no edit here. The unit spec
  pins the invariant that a check on an undeclared predicate is always
  gap-gated — the battery cannot hardcode green.
- **k08** — needs the coding-verb state-verb lexicon (parallel PR) AND
  `EXTRACTOR_STATE_VERB_HARVEST=1` at the stand; even then, holder
  binding routes "we enabled FLAG" to the AGENT entity, so the full
  story landing on one timeline is unmeasured.

k14 is the deliberate NEGATIVE twin of k08: it must hold today (no
coding verbs in the lexicon → nothing to guard) and keep holding after
the lexicon lands (the 6-token pre-verb guards are then what keeps it
green). k10 (cross-entity) is un-gated on purpose: a fail there is a
genuine platform finding, not a known gap. It measures IDENTITY alone —
the runner resolves the ONE named entity strictly, then scans ALL facts
ever recorded onto it (`get_entity_timeline` ∪ the hit's top facts)
predicate-agnostically, so a clause extraction split or mis-slotted
still counts as long as it is ATTACHED to the module; which predicate a
clause lands in is scored by the vocab checks (k02-k06), never
re-punished here.

## Running against a local stand

Same stand as the siblings: a booted brain (with its OpenAI key),
driven purely over the wire — **never run in CI** (the runner exits
with a clear message when `BRAIN_BASE_URL` is unset).

- **A FRESH tenant per run** (`BRAIN_COMPANY_ID`) — the battery asserts
  entity dedup and reads whole timelines; a reused tenant contaminates
  both.
- **No registry seeding, no pack install** — `code_memory` is builtin.
  Do NOT try to install it; the install endpoint rejects builtin ids.
- The API key needs `brain:read + brain:write + brain:admin`
  (`admin` for the phase-0 predicates read; `write` for
  `record_decision` — without it k09/k15 are skipped, never passed).

Stand flags that shape coverage:

- `EXTRACTOR_LITERAL_HARVEST=1` — required for k07 (ON in prod).
- `EXTRACTOR_STATE_VERB_HARVEST=1` — shapes k08/k14 (the transition
  lane; k14 must stay green with it on or off).
- `FACTS_API_ENABLED=1` — required for k11 (`get_fact_provenance` is
  otherwise absent; the check is skipped, never silently passed).
- `THROTTLE_DISABLED=1` — recommended; the runner backs off on 429
  otherwise.

Then:

```bash
BRAIN_BASE_URL=http://localhost:3000 \
BRAIN_API_KEY=... \
BRAIN_COMPANY_ID=<fresh tenant> \
pnpm eval:code-memory
```

Knobs (`CMEV_` prefix, mirroring the siblings' `MEMFIT_` / `STEV_` /
`DPEV_`): `CMEV_USER_ID` (default `cm-agent`), `CMEV_RUN_ID` (default
time-derived; conversation ids and MCP anchors are run-scoped so
re-runs never collide), `CMEV_GUARDRAILS` (`strict`|`lenient`|`off`,
default `strict`), `CMEV_SKIP_INGEST=1` (re-ask an already-ingested
run — requires the same `CMEV_RUN_ID`), `CMEV_REPORT_DIR` (default
`var/code-memory/`).

The JSON scorecard lands in `var/code-memory/code-memory-<runId>.json`
— per-class and per-check-kind tallies, the phase-0 setup trail, the
gap-gated id list, every verdict with its detail (and the raw served
answers), so any verdict is reproducible from the report file alone.
