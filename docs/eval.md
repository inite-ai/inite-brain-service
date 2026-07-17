# Eval harness

The retrieval + memory-lifecycle quality gate and how to run it on your
own data — for contributors and operators measuring Brain.

`test/eval/` is the production gate, not a smoke folder. It runs
against a spawned brain process with real OpenAI, against ~250
retrieval queries plus 3 synthesize scenarios, and asserts hard
thresholds per vertical AND overall.

## Layout

```
src/eval/                       # ships in the prod image
                                # (admin scenario runner reads at runtime)
├── scenarios/                  # 16 declarative .scenarios.ts files
│                               # + Allen-relation matrix
├── fixtures/                   # fat-tenant generator
└── types.ts

test/eval/                      # test-time eval harness
├── http-brain-client.ts        # spawns a real brain process,
│                               # drives it via HTTP
├── fixtures/                   # wikidata Russian-writers
│                               # (Latin + Cyrillic), example JSON dirs
├── loaders/                    # JsonDirectory loader
│                               # + Wikidata SPARQL mapper
│                               # + query-bank generator
├── metrics/                    # recall@k, MRR, NDCG, joint-F1,
│                               # faithfulness, MIA-AUC,
│                               # identity-resolution (B³),
│                               # bootstrap CI
└── runner/                     # SetupApplier, QueryExecutor,
                                # MemoryAssertions, MiaChecker,
                                # FaithfulnessChecker, Aggregator,
                                # Reporter
```

Scenarios + fixture generator live under `src/eval/` because the admin
scenario runner (`/v1/admin/scenarios/run`) loads them at runtime —
they're production code, not test code. The runner / loader / metrics
modules stay under `test/eval/`.

## What the report contains

- **Per-vertical + overall** for recall@1 / 3, MRR, NDCG@10
- **Bootstrap 95% CI** on every retrieval metric (1000 resamples,
  seeded mulberry32 — CI itself is reproducible)
- **Per-predicate breakdown** — surfaces "router weak on dob" that
  overall=0.95 hides
- **Temporal / current split** — partitioned by whether the query
  carried `asOf`; null on empty partition (not 0)
- **Identity-resolution F1 / precision / recall** (B³-style with
  declared distractors; placebo `rate(merged)` retired)
- **Faithfulness mean + pass-rate + verifier-failures** — RAGAS claim-
  decomposition; sourceFacts fall back to retrieved-context when
  emitted citations are thin
- **MIA-AUC** with underpowered guard — auto-bypasses gate when
  `N_pos + N_neg < 30` (default `MIA_MIN_N`)
- **Memory-lifecycle correctness** — update / supersede / retract /
  forget assertions; threshold = 1.0
- **PII-gating correctness** — fact-level absence assertions;
  threshold = 1.0

## CI gate

Wired into CI via `actions/cache@v4` baseline. Each green push to main
writes a fresh `.eval-baseline/main.json`; PR / dispatch runs diff
against the most recent baseline and fail on regression beyond per-
metric tolerance (`scripts/eval-baseline-diff.ts`):

```
recall/MRR/NDCG/F1     >3pp drop  → block
extraction-*           >5pp drop  → block
identity / pii-gating  >1pp drop  → block
memory-lifecycle       any drop   → block (must equal 1.0)
MIA-AUC                >5pp rise  → block (lower is better)
others                 >5pp drop  → block
```

## Running locally

`pnpm test:eval` runs the full suite locally. Set
`BRAIN_EVAL_DIRECTORY_DISABLE=1` to skip the wikidata legs for fast-
iteration loops; default behaviour pulls in `wd-russian-writers.json`
+ `wd-russian-writers-ru.json` and samples 30 entities (seed=42,
deterministic) × 3 query templates per directory.

## Loading a custom directory

Two paths depending on what you've got.

### Path A — JSON file (recommended)

Hand your CRM export through `pnpm test:eval:json`. The loader
(`test/eval/loaders/json-directory.loader.ts`) reads a flat JSON shape
and feeds it into the same eval runner the synthetic suites use, so
retrieval AND memory-lifecycle assertions both apply.

JSON schema:

```json
{
  "directoryName": "acme",
  "description": "ACME CRM export 2026-Q2",
  "entities": [
    {
      "id": "alice_smith",
      "facts": [
        { "predicate": "name",  "object": "Alice Smith",       "validFrom": "2026-01-01T00:00:00Z", "confidence": 0.95 },
        { "predicate": "email", "object": "alice@example.com", "validFrom": "2026-01-01T00:00:00Z" },
        { "predicate": "tier",  "object": "gold",     "validFrom": "2026-02-01T00:00:00Z", "validUntil": "2026-04-01T00:00:00Z" },
        { "predicate": "tier",  "object": "platinum", "validFrom": "2026-04-01T00:00:00Z" },
        { "predicate": "complained_about", "object": "broken washer", "validFrom": "2026-03-15T00:00:00Z", "tag": "alice-complaint-1" }
      ],
      "retract": [
        { "tag": "alice-complaint-1", "reason": "tenant withdrew the report" }
      ]
    }
  ],
  "forgetEntities": [
    { "ref": "alice_smith", "reason": "gdpr_request", "requestId": "GDPR-2026-001" }
  ],
  "queries": [
    { "query": "Alice Smith tier", "expectedTopEntityRef": "acme.alice_smith", "expectedFactPredicate": "tier" }
  ],
  "memoryAssertions": [
    { "description": "platinum surfaces", "kind": "search_object_present", "query": "Alice Smith tier", "expectedRefPresent": "acme.alice_smith", "objectSubstring": "platinum" }
  ]
}
```

Schema rules:
- `directoryName` is the default vertical for entity refs that don't
  override; surfaces in the scenario id.
- Every entity needs at least one fact; every fact needs `predicate` +
  `object` + `validFrom`.
- `tag` on a fact is the handle a retract step references; tags must
  be unique within the entity.
- Retract steps live INSIDE the entity (`entity.retract[]`) — keeps
  the lifecycle local. Forget steps are top-level
  (`forgetEntities[]`) because the cascade depends on every fact
  having been ingested first.
- `forgetEntities[].ref` accepts either `id` (uses default vertical)
  or `vertical.id` (explicit).
- `queries` and `memoryAssertions` are optional but encouraged —
  without them the run only validates ingest, not whether brain's read
  side reflects the lifecycle ops.

Run with:

```bash
OPENAI_API_KEY=sk-... \
  BRAIN_DIRECTORY_JSON=/path/to/your/customers.json \
  pnpm test:eval:json
```

The loader cites the offending field and source path on any shape
mismatch — operators editing JSON by hand hit "expected string for
`id`, got number" instead of a downstream NaN cast. See
`test/eval/fixtures/example-directory.json` for a working 3-entity
smoke fixture covering update / retract / forget.

### Path B — Wikidata fetcher (real public-domain data)

For loading a real directory, a built-in fetcher pulls a slice through
the public Wikidata Query Service (CC0 data, no API key, rate-limited
but free):

```bash
# Russian writers — Cyrillic / Latin name aliasing, sparse bibliographies
pnpm directory:fetch:wikidata russian-writers 1000 \
  --out test/eval/fixtures/wd-russian-writers.json

# Nobel Prize in Literature laureates — multi-locale names, dense biographical data
pnpm directory:fetch:wikidata nobel-laureates-literature 200 \
  --out wd-nobel.json

# US software companies — multi-word names, headquarters, founding dates
pnpm directory:fetch:wikidata tech-companies-us 200 \
  --out wd-tech.json
```

The fetcher exits 0 on stderr-logged stats (binding count, unique
entities, emitted facts) and writes the `JsonDirectory` to `--out`.
Then run the eval against it:

```bash
OPENAI_API_KEY=sk-... \
  BRAIN_DIRECTORY_JSON=test/eval/fixtures/wd-russian-writers.json \
  pnpm test:eval:json
```

Property mapping (Wikidata → Brain predicates):

| Wikidata | Brain predicate | Notes |
|---|---|---|
| `?itemLabel` | `name` | First fact per entity. |
| `?dob` (P569) | `dob` | Trimmed to YYYY-MM-DD; PII-gated (`brain:read_pii`). |
| `?birthPlaceLabel` (P19) | `address` | Object prefixed `birthplace: …`. |
| `?countryLabel` (P27) | `address` | `country: …`. |
| `?hqLabel` (P159) | `address` | `headquarters: …`. |
| `?occupationLabel` (P106) | `interacted_with` | `occupation: …`. |
| `?genreLabel` (P136) | `preference` | `genre: …`. |
| `?awardLabel` (P166) | `interacted_with` | `received …`. |
| `?inception` (P571) | `interacted_with` | `founded YYYY-MM-DD`. |

Adding a new template: declare it in `WIKIDATA_TEMPLATES`
(`test/eval/loaders/wikidata-mapper.ts`) — the SPARQL body, the
`directoryName`, the description. Variables matching the table above
auto-map; new variables need a small extension to the mapper.

The repo ships `test/eval/fixtures/wd-russian-writers.json`
(~91 entities, 882 facts, Cyrillic names) as a known-good sample for
smoke runs and CI.

### Path C — programmatic (for non-JSON sources)

The directory eval (`pnpm test:eval:directory`) uses a synthetic
generator, but the same pipeline accepts any `Scenario` shape:

1. Read your source (CSV / API / Parquet) into the in-memory `setup:
   SetupStep[]` array. Each row becomes one `{ kind: 'fact', entityRef,
   predicate, object, validFrom, source }` step. Map your domain
   predicates onto brain's vocabulary (`name` / `email` / `tier` /
   `status` / `complained_about` / `interacted_with` / `address` / …).
2. Add `tag` to fact steps you intend to retract later, plus a
   `{ kind: 'retract', tag, reason }` step. Use `{ kind: 'forget',
   entityRef, reason, requestId }` for GDPR cascades.
3. Optionally add `memoryAssertions: MemoryAssertion[]` for lifecycle
   validation.
4. Drop the resulting `Scenario` into a new spec file modelled on
   `test/directory.real-e2e-spec.ts`.

Seeding cost is dominated by HNSW + BM25 indexing — budget ~1 minute
per 5k facts on a single Surreal node, scaling near-linearly. Set Jest
timeouts to 30+ minutes for fixtures over 50k rows.

## Joint F1 + faithfulness scoring (programmatic)

```ts
import { jointF1 } from './test/eval/metrics/joint-f1';

const score = jointF1(
  {
    answerEntityRefs: response.finalEntityIds,
    supportingFactIds: response.supportingFactIds,
  },
  {
    answerEntityRefs: ['acme.alice'],
    supportingFactIds: ['gold_fact_1', 'gold_fact_2'],
  },
);
// → { answerF1, supportF1, jointF1, answerEM, supportEM, jointEM, ... }
```

```ts
import OpenAI from 'openai';
import { computeFaithfulness } from './test/eval/metrics/faithfulness';

const synthRes = await brainClient.synthesize({...});
const score = await computeFaithfulness(new OpenAI(), {
  answer: synthRes.answer,
  sourceFacts: synthRes.results.flatMap((r) =>
    r.facts.map((f) => ({ factId: f.factId, predicate: f.predicate, object: f.object })),
  ),
});
// → { faithfulness: 0.83, totalClaims: 6, supportedClaims: 4, partialClaims: 1, unsupportedClaims: 1, claims: [...] }
```

## A/B measuring domain-routed retrieval

`SEARCH_DOMAIN_ROUTING_ENABLED` is a ranking-behaviour flag, so the
golden-baseline gate (which runs flag-off) can't measure it — the two
arms differ only when the flag flips. Measure it as a paired A/B on a
tenant that actually has domain packs installed (routing is a no-op with
none installed):

```bash
# Arm A — baseline (flag off)
BRAIN_EVAL_REPORT_OUT=./ab-off.json pnpm test:eval

# Arm B — filter mode on
SEARCH_DOMAIN_ROUTING_ENABLED=1 \
SEARCH_DOMAIN_ROUTING_MODE=filter \
BRAIN_EVAL_REPORT_OUT=./ab-on.json pnpm test:eval

pnpm eval:diff ./ab-off.json ./ab-on.json
```

Read it against two axes:

- **Recall must not regress.** `recall@k` / `MRR` / `NDCG` diffs stay
  within the `>3pp drop → block` tolerance — narrowing that strands the
  gold answer shows up here. A high `search.retrieval_backoff` rate in
  the arm-B traces means the `MIN_SIM` threshold is mis-calibrated
  (queries matched a domain but the gold facts were outside it); raise
  `SEARCH_DOMAIN_ROUTING_MIN_SIM` or fall back to `MODE=boost`.
- **Precision / cost should improve.** Fewer candidates reach the
  reranker (the `search.query` / vector-leg `candidates` trace counts)
  for the same or better top-1 — the token-cost win. Compare the
  per-vertical `recall@1` deltas for the packed domains.

Start rollout at `MODE=boost` (zero recall risk — scoring multiplier
only), and promote to `filter` per-tenant once the A/B on that tenant's
corpus shows recall flat and candidate counts down.

## See also

- [LoCoMo benchmark](locomo.md) — the external long-term-memory benchmark run through the same surfaces.
- [Operations § Tests](operations.md#tests) — the full test-command matrix.
- [Domain Packs § Eval fixtures](domain-packs.md#eval-fixtures-consumed) — per-pack extraction evals.
