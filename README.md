# INITE Brain Service

Cross-vertical knowledge layer for the INITE ecosystem. **System of insight, not system of record.**

Production: **https://brain.inite.ai** · auto-deploy on push to `main` via `[self-hosted, sfo]` · runbook in [`docs/DEPLOY.md`](docs/DEPLOY.md)

Implements [`inite.service.brain`](https://github.com/inite/inite-ecosystem/blob/main/core/services/brain.yaml) and the [`knowledge`](https://github.com/inite/inite-ecosystem/blob/main/core/capabilities/knowledge.yaml) capability bundle from `inite-ecosystem` v0.2.0-rc.4.

```
recall@1   0.965  [0.94–0.98]  n=255   ← multi-vertical quality eval, latest gate run
MRR        0.979  [0.97–0.99]  n=255
NDCG@10    0.979
identity-resolution-f1   1.000
pii-gating-correctness   1.000
memory-lifecycle         1.000
faithfulness pass-rate   1.000  n=3
```

CI gate floors: recall@1 ≥ 0.6, recall@3 ≥ 0.8, MRR ≥ 0.5, identity-F1 ≥ 0.8,
pii-gating = 1.0, memory-lifecycle = 1.0, faithfulness pass-rate ≥ 0.8.
Bootstrap-CI on every retrieval metric; per-predicate breakdown + per-vertical
split + temporal/current partition all in the report. Numbers from the
multi-vertical scenario suite plus 180 wikidata queries (90 Latin + 90 Cyrillic).

## What it is

Brain maintains a per-tenant **bitemporal knowledge graph** (entities, facts, edges) derived from ecosystem events. Verticals use the `@inite/knowledge` SDK for semantic search and entity profiles, and AI agents connect via a per-tenant MCP endpoint.

Brain does **not** read from any vertical's database. State is ingested through the ecosystem event stream and through public vertical APIs at backfill time. Brain does **not** write back into any vertical's database.

## Architecture position

```
Layer 4 — Verticals
Layer 3 — @inite/* SDKs        ← @inite/knowledge consumes brain
Layer 2 — Horizontal services  ← inite.service.brain (this service)
Layer 1 — Identity (auth)
```

## Endpoints

All v1 endpoints are live; MCP transport is mounted per tenant.

| Endpoint | Notes |
|---|---|
| `GET /health` | container + SurrealDB readiness |
| `GET /metrics` | Prometheus exposition (in-cluster scrape) |
| `POST /v1/ingest/fact` | declared structured fact ingest |
| `POST /v1/ingest/mention` | NLU extraction → entities + facts |
| `POST /v1/ingest/link` | typed edge between entities (incl. `identity_of` for cross-vertical merge) |
| `POST /v1/search` | hybrid (vector + BM25), router-boosted, listwise rerank w/ self-consistency, per-leg CI, entity-fact backfill |
| `POST /v1/synthesize` | corrective-RAG with strict / lenient / off guardrails + claim-level faithfulness scorer |
| `POST /v1/search/multi-hop` | planner-LLM decomposes the query into ≤N anchored sub-queries; carries supportingFactIds for HotpotQA-style joint-F1 eval |
| `GET /v1/entities/:id` | entity profile + active facts (PII-gated by scope) |
| `GET /v1/entities/:id/timeline` | bitemporal sweep — all facts ever known, with validFrom / validUntil / recordedAt / retractedAt |
| `GET /v1/entities/:id/connections` | typed edges + direct neighbours |
| `POST /v1/facts/:id/retract` | mark a fact retracted with reason; survives in audit trail |
| `POST /v1/entities/:id/forget` | hard GDPR cascade — facts + edges + embeddings deleted, HMAC tombstone retained |
| `GET /v1/artifacts/:type/:entityId` | derived artifacts (profile / digest / etc) with manual `recompile` POST |
| `POST /v1/dreams/run` | off-hours self-improvement: dedup / resolve / summarize (admin scope) |
| `ALL /mcp/:companyId` | Streamable HTTP MCP endpoint per tenant |

## Tech stack

- **NestJS 11** + TypeScript on Node 22-alpine; OTel auto-instrumentation
- **SurrealDB 2.3.10** with HNSW vector index + BM25 search analyzer + bitemporal model
  - Tenancy: namespace `inite`, database `co_<companyId>` per tenant (per-tenant data isolation, single `REMOVE DATABASE` to forget)
  - DB-level PII fence via PERMISSIONS + `$caller_scopes`, scoped pool signs in as `brain_caller` editor user
- **OpenAI** `gpt-4o-mini-2024-07-18` (snapshot-pinned) for extraction / synthesize / faithfulness verifier; `text-embedding-3-small` (1536d) for vectors
- **Cohere Rerank v3.5** optional cross-encoder between fusion and the LLM stage
- Deployment: Docker Hub image, Traefik routing on the inite-temporal droplet, Let's Encrypt cert auto-provision
- Auth: JWKS via `auth.inite.ai` (audience `brain`); static `BRAIN_API_KEYS` map as fallback for dev only

## Local development

```bash
# Start SurrealDB
docker compose up -d surrealdb

# Install + run
pnpm install
cp .env.example .env
# Fill OPENAI_API_KEY and (if exposing) BRAIN_API_KEYS

pnpm start:dev
```

### Seed an ApiKey for local testing

```bash
node -e "console.log('sha256:'+require('crypto').createHash('sha256').update('local-dev-key').digest('hex'))"
# → sha256:abc...
```

Put into `.env`:

```
BRAIN_API_KEYS=[{"keyHash":"sha256:abc...","companyId":"co_demo","scopes":["brain:read","brain:write"]}]
```

### Smoke test

```bash
# Ingest one fact
curl -X POST http://localhost:3000/v1/ingest/fact \
  -H "Authorization: Bearer local-dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "entityRef": { "vertical": "rent", "id": "cust_42" },
    "predicate": "complained_about",
    "object": "late maintenance response",
    "validFrom": "2026-05-05T10:00:00Z",
    "source": { "vertical": "rent", "messageId": "msg_1" }
  }'

# Search
curl -X POST http://localhost:3000/v1/search \
  -H "Authorization: Bearer local-dev-key" \
  -H "Content-Type: application/json" \
  -d '{ "query": "maintenance issues", "limit": 5 }'
```

## Loading a custom directory for eval

Two paths depending on what you've got:

### Path A — JSON file (recommended)

Hand your CRM export through `pnpm test:eval:json`. The loader (`test/eval/loaders/json-directory.loader.ts`) reads a flat JSON shape and feeds it into the same eval runner the synthetic suites use, so retrieval AND memory-lifecycle assertions both apply.

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
- `directoryName` is the default vertical for entity refs that don't override; surfaces in the scenario id.
- Every entity needs at least one fact; every fact needs `predicate` + `object` + `validFrom`.
- `tag` on a fact is the handle a retract step references; tags must be unique within the entity.
- Retract steps live INSIDE the entity (`entity.retract[]`) — keeps the lifecycle local. Forget steps are top-level (`forgetEntities[]`) because the cascade depends on every fact having been ingested first.
- `forgetEntities[].ref` accepts either `id` (uses default vertical) or `vertical.id` (explicit).
- `queries` and `memoryAssertions` are optional but encouraged — without them the run only validates ingest, not whether brain's read side reflects the lifecycle ops.

Run with:

```bash
OPENAI_API_KEY=sk-... \
  BRAIN_DIRECTORY_JSON=/path/to/your/customers.json \
  pnpm test:eval:json
```

The loader cites the offending field and source path on any shape mismatch — operators editing JSON by hand hit "expected string for `id`, got number" instead of a downstream NaN cast. See `test/eval/fixtures/example-directory.json` for a working 3-entity smoke fixture covering update / retract / forget.

### Path A.1 — Wikidata fetcher (real public-domain data)

For "залить настоящий справочник", a built-in fetcher pulls a slice through the public Wikidata Query Service (CC0 data, no API key, rate-limited but free):

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

The fetcher exits 0 on stderr-logged stats (binding count, unique entities, emitted facts) and writes the `JsonDirectory` to `--out`. Then run the eval against it:

```bash
OPENAI_API_KEY=sk-... \
  BRAIN_DIRECTORY_JSON=test/eval/fixtures/wd-russian-writers.json \
  pnpm test:eval:json
```

Property mapping (Wikidata → Brain predicates):

| Wikidata | Brain predicate | Notes |
|---|---|---|
| `?itemLabel` | `name` | First fact per entity |
| `?dob` (P569) | `dob` | Trimmed to YYYY-MM-DD; PII-gated (`brain:read_pii`) |
| `?birthPlaceLabel` (P19) | `address` | Object prefixed `birthplace: …` |
| `?countryLabel` (P27) | `address` | `country: …` |
| `?hqLabel` (P159) | `address` | `headquarters: …` |
| `?occupationLabel` (P106) | `interacted_with` | `occupation: …` |
| `?genreLabel` (P136) | `preference` | `genre: …` |
| `?awardLabel` (P166) | `interacted_with` | `received …` |
| `?inception` (P571) | `interacted_with` | `founded YYYY-MM-DD` |

Adding a new template: declare it in `WIKIDATA_TEMPLATES` (`test/eval/loaders/wikidata-mapper.ts`) — the SPARQL body, the `directoryName`, the description. Variables matching the table above auto-map; new variables need a small extension to the mapper.

The repo ships `test/eval/fixtures/wd-russian-writers.json` (~91 entities, 882 facts, Cyrillic names) as a known-good sample for smoke runs and CI.

### Path B — programmatic (for non-JSON sources)

The directory eval (`pnpm test:eval:directory`) uses a synthetic generator, but the same pipeline accepts any `Scenario` shape:

1. Read your source (CSV / API / Parquet) into the in-memory `setup: SetupStep[]` array. Each row becomes one `{ kind: 'fact', entityRef, predicate, object, validFrom, source }` step. Map your domain predicates onto brain's vocabulary (`name` / `email` / `tier` / `status` / `complained_about` / `interacted_with` / `address` / …).
2. Add `tag` to fact steps you intend to retract later, plus a `{ kind: 'retract', tag, reason }` step. Use `{ kind: 'forget', entityRef, reason, requestId }` for GDPR cascades.
3. Optionally add `memoryAssertions: MemoryAssertion[]` for lifecycle validation.
4. Drop the resulting `Scenario` into a new spec file modelled on `test/directory.real-e2e-spec.ts`.

Seeding cost is dominated by HNSW + BM25 indexing — budget ~1 minute per 5k facts on a single Surreal node, scaling near-linearly. Set Jest timeouts to 30+ minutes for fixtures over 50k rows.

## Retrieval pipeline

`POST /v1/search` runs a layered pipeline. Each stage is optional / env-flagged
and tracked in metrics so an operator can A/B per-tenant impact without
redeploying. Default-prod config in [`docs/DEPLOY.md`](docs/DEPLOY.md).

```
                   query
                     │
                     ▼
       ┌─────────────────────────────┐
       │ predicate + type router     │  joint LLM call → soft distribution
       │ (LRU-cached per query hash) │  over predicates + entity types
       └─────────────────────────────┘
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
  vector leg   lexical leg   (HyPE alt-emb leg)
  (HNSW cos)   (BM25)        max(cos_main, cos_alt)
       │             │             │
       └─────────────┼─────────────┘
                     ▼
       convex-fusion (CombMNZ-flavoured w=0.5)
                     │
                     ▼
       decay × confidence × predicate-boost-α (per class; PII discriminators α=1.5)
                     │
                     ▼
       group-by-entity ──→  PPR prior (HippoRAG, opt-in, gated by candidate-set size)
                     │
                     ▼
       cross-encoder (Cohere Rerank v3.5, opt-in, identity-fallback on error)
                     │
                     ▼
       listwise LLM reranker  ──→  permutation self-consistency (N=3 default; Borda count)
       (RankGPT-style + 1-hop SubgraphRAG neighbour context + type-prior hint)
                     │
                     ▼
       entity-fact backfill (native Surreal inline subquery via $parent.id;
       per-entity LIMIT 50; predicate-diverse top-N merge with matched facts)
                     │
                     ▼
       identity-merge re-attribution
                     │
                     ▼
                  results
```

Notable design points:
- **Backfill is a single SurrealDB SELECT with inline subquery** — not a second round-trip. Solves the "leg returned the right entity but the matching dob/address fact wasn't in top-K candidates" mode that buried predicate-match-rate at 0.4 before.
- **Per-class boost α** — most predicates get 0.5 (soft); PII discriminators (`dob`, `email`, `phone`) get 1.5 because a router call "this is a dob lookup" should reliably win against a same-entity name fact.
- **Bitemporal cutoff is in WHERE** — `validFrom <= asOf < validUntil` and `retractedAt IS NONE OR retractedAt > asOf` push down into the leg query, no JS post-filter.
- **PII gating** — DB-level via `PERMISSIONS WHERE $caller_scopes CONTAINS 'brain:read_pii'` on the `object` field of `address`/`dob`. Scoped pool signs in as a non-root editor; scope-less callers get NONE for the value but still see the predicate exists.

Full feature-flag matrix in the `Operations` section.

## Dreams (off-hours self-improvement)

A daily cron (04:00 UTC, 43 min after compaction) that walks every tenant and runs three optional sub-passes over the post-compaction state. Each is independently env-gated; `DREAMS_ENABLED=1` is the master switch.

| Sub-op | Env flag | What it does |
|---|---|---|
| `summarize` | `DREAMS_LLM_SUMMARY_ENABLED=1` | Replaces the no-LLM concat summarizer in compaction with an LLM-backed version. Produces 1-2 sentence summaries that capture the trajectory ("upgraded from gold to platinum in April") instead of a verbatim concat. Falls back to concat on any LLM error — compaction never breaks. |
| `dedup` | `DREAMS_DEDUP_ENABLED=1` | Two-stage dedup: (1) cosine-similarity over name embeddings finds suspect pairs (threshold `DREAMS_DEDUP_COSINE_THRESHOLD`, default 0.92); (2) LLM judge with both entities' top facts as context decides `same` / `different` / `unsure`. `same` → emits `identity_of` edge automatically. Bounded by `DREAMS_DEDUP_MAX_PAIRS` per tenant per run. |
| `resolve` | `DREAMS_RESOLVE_ENABLED=1` | Auto-resolves `competing` fact pairs aged past `DREAMS_RESOLVE_MIN_AGE_DAYS` (default 7). LLM judge picks a winner using surrounding entity context; loser marked `superseded` with `retractionReason='dreams_resolution'`. Conservative — `unsure` verdict leaves both for human review. |

Manual trigger:

```bash
curl -X POST http://localhost:3000/v1/dreams/run \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "operations": ["dedup", "resolve"] }'
```

Body shape: `{ "operations"?: ("dedup" | "resolve" | "summarize")[] }`. Empty / unset → uses env-default subset. Scoped to `brain:admin` because the operations mutate state no other v1 endpoint exposes.

Metrics: `brain_dreams_total{outcome=ok|failed}`, `brain_dreams_emitted_total{kind=identity_link|resolution|summary}`. The emitted ratio against ok-runs tells the operator whether dreams is doing useful work or just spinning.

## Multi-hop search

`POST /v1/search/multi-hop` runs a CHAINED search: a planner LLM decomposes the free-text query into ≤ `maxHops` sub-queries with combination semantics, then the executor runs them in sequence — each later hop optionally anchored to the running entity set so the search engine never wastes work on candidates already disqualified upstream.

Combination modes (planner-emitted, per hop):

- **seed** — first hop, no prior set
- **subset_of_previous** — search is anchored via `entityIds` to the running set; result is a strict subset. Most chained reasoning ("FROM the previous result, KEEP those that ALSO …") uses this.
- **intersect** — hop runs unconstrained; intersect with running set after the fact (preserves recall when the prior set is small)
- **union** — hop runs unconstrained; union with running set (rare; included for completeness)

When the planner reports `isMultiHop=false`, the executor falls back to a single-shot search — same shape as `POST /v1/search` but with the planner's potentially refined `subQuery` / predicate / asOf.

Set `synthesize: true` to feed the final entity set into `/v1/synthesize` and get a grounded answer alongside the per-hop trace.

```bash
curl -X POST http://localhost:3000/v1/search/multi-hop \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "tenants who complained in April and upgraded to platinum after",
    "maxHops": 3,
    "synthesize": true
  }'
```

Response carries `hops[]` (per-hop sub-query + entity-id list + supportingFactIds) plus an aggregated top-level `supportingFactIds` (de-duped, in execution order). The supporting-facts shape is what HotpotQA-style **Joint F1** scoring compares against the gold evidence chain — see `test/eval/metrics/joint-f1.ts`. Use it to catch the failure mode end-to-end recall@k cannot see: a system that produces the right answer via the wrong reasoning chain.

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

## Synthesize (corrective-RAG)

`POST /v1/synthesize` is `/v1/search` with one extra step: the retrieved facts get fed to a generator LLM that produces a grounded, citation-bearing answer (each claim ends with `[factId]`), and then a verifier LLM judges whether every claim is supported by the source facts. Three modes:

- **strict** (default) — verifier must return `supported`. Anything else (`partial` / `unsupported`) collapses to `answer: null` with a `reason` field. Fail-closed on verifier outage too.
- **lenient** — verifier still runs, but the answer is returned regardless. The verifier's verdict is exposed via `reason` so the caller can decide.
- **off** — skip verifier (cheapest; for callers that do their own grounding).

Hallucinated `factId` citations (the LLM cited an id not in the retrieved set) are filtered before the response leaves the server. The `results` field carries the raw `SearchHit[]` so callers can fall back to manual synthesis when the answer is null.

For continuous quality measurement, score synthesize outputs against the retrieved context with `computeFaithfulness` (RAGAS convention — see `test/eval/metrics/faithfulness.ts`). It decomposes the answer into atomic claims and returns a 0..1 score plus the per-claim verdicts, so a regression report points at *which* sentence hallucinated, not just "this answer was wrong":

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

```bash
curl -X POST http://localhost:3000/v1/synthesize \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{ "query": "who reported maintenance issues last month?", "synthesisGuardrails": "strict" }'
```

## Bitemporal model

Every fact carries two time axes:

- `validFrom` / `validUntil` — when the fact was true in the **real world**
- `recordedAt` / `retractedAt` — when **brain knew** about it

**Default search = "actual now"** (Datomic / Zep convention). Without `asOf`, brain returns only currently-true facts: `validFrom <= now < validUntil`, status not superseded/compacted, not retracted. Audit / historical access through `asOf=<date>` or `includeStale: true`. Conflict resolver uses Allen's interval algebra — sequential validity intervals don't compete. Full semantics in [`docs/bitemporal-semantics.md`](docs/bitemporal-semantics.md).

## Predicate vocabulary + conflict resolution

Brain governs how facts are merged via per-predicate policies (semantics, decay half-life, PII class). The vocabulary and the conflict-resolution algorithm are **declared in the spec** at `inite-ecosystem/core/capabilities/knowledge.yaml`.

Quick reference (full table in spec):

| Predicate | Semantics | Decay half-life | PII class |
|---|---|---|---|
| `said` | append_only | 30d | text |
| `name` / `email` / `phone` | single_active | never | identifier |
| `status` | bitemporal | 7d | none |
| `intent` | bitemporal | 60d | behavioral |
| `address` | bitemporal | 90d | sensitive (`brain:read_pii` required) |
| `dob` | single_active | never | sensitive (`brain:read_pii` required) |

Conflict resolution scoring:

```
score = 0.30·confidence + 0.40·source_trust + 0.20·recency + 0.10·authority
```

New fact wins over best contradicting fact only if it beats it by ≥ 0.15. Below 0.30, ingest is rejected to a dead-letter table. Margins between produce `COMPETING` status — both stay active, an event is emitted for human resolution.

## Tenancy + data isolation

Each company gets its own SurrealDB database `co_<companyId>` inside the
shared `inite` namespace. Cross-tenant queries are physically impossible at
the storage layer — there is no shared table with row-level security.
Forgetting a tenant is `REMOVE DATABASE` (single statement). Migrations
apply per tenant on first request via `ensureSchema` (idempotent).

## Privacy + GDPR

- Raw message content is **not** persisted. Brain stores AI-derived insights and a reference back to the source vertical (e.g., `{ vertical: "inbox", messageId: "..." }`).
- Hard-forget is synchronous: `POST /v1/entities/:id/forget` cascades through facts, edges, and embeddings, leaving only an HMAC-hash tombstone in `forgotten_entity`.
- Sensitive predicates are gated by `brain:read_pii` scope — they never appear in MCP results to AI agents without it.

## Operations

### Required env vars

| Var | Notes |
|---|---|
| `SURREALDB_URL` | `ws://` / `wss://` (or `http(s)://`) |
| `SURREALDB_USERNAME` / `SURREALDB_PASSWORD` | root credentials for the DB |
| `OPENAI_API_KEY` | `sk-...` — used for embeddings + LLM extraction |
| `BRAIN_API_KEYS` | JSON array of `{ keyHash, companyId, scopes }`. Plaintext keys are NEVER stored — `keyHash` is `sha256:<hex>` of the plaintext you give a caller. |
| `FORGET_HMAC_KEY` | Secret used to HMAC-hash entity ids in `forgotten_entity` tombstones. **MUST be set in production** — using the default lets anyone forge tombstone hashes. Validation hard-fails the service in `NODE_ENV=production` when missing. |

### Optional env vars

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `NODE_ENV` | unset | Set `production` to enable strict env checks (FORGET_HMAC_KEY required, empty BRAIN_API_KEYS warned). |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | |
| `OPENAI_EMBEDDING_DIMENSIONS` | `1536` | Must match the schema's HNSW dim if HNSW is later enabled. |
| `OPENAI_CHAT_MODEL` | `gpt-4o-mini` | Used by `ingest-mention` extraction. |
| `CONFLICT_*` | per spec | Override the resolution weights at runtime; defaults match `core/capabilities/knowledge.yaml`. |
| `MULTI_HOP_PLANNER_MODEL` | `OPENAI_CHAT_MODEL` | Override the chat model for the multi-hop planner LLM call. |
| `DREAMS_ENABLED` | `0` | Master switch for the daily dreams cron. Each sub-op has its own gate (`DREAMS_DEDUP_ENABLED`, `DREAMS_RESOLVE_ENABLED`, `DREAMS_LLM_SUMMARY_ENABLED`). Manual `POST /v1/dreams/run` works regardless of this flag. |
| `DREAMS_DEDUP_ENABLED` | `0` | Enable near-duplicate entity finder (cosine + LLM judge). Cost: 1 cosine-kNN per active-named entity (cheap) + 1 LLM call per suspect pair. Bounded by `DREAMS_DEDUP_MAX_PAIRS` (default 50). |
| `DREAMS_RESOLVE_ENABLED` | `0` | Enable competing-fact auto-resolver. Only resolves pairs aged past `DREAMS_RESOLVE_MIN_AGE_DAYS` (default 7). Bounded by `DREAMS_RESOLVE_MAX_PAIRS` (default 20). |
| `DREAMS_LLM_SUMMARY_ENABLED` | `0` | Swap the compaction summary generator from concat to LLM-backed. The LlmSummaryGenerator falls back to concat on any LLM error, so flipping the flag is safe (worst case = unchanged behaviour). |
| `MULTI_HOP_PLANNER_CONCURRENCY` | `4` | Max in-flight planner calls. |
| `SYNTHESIZE_MODEL` | `OPENAI_CHAT_MODEL` | Override the chat model for `/v1/synthesize` generator + verifier calls. |
| `SYNTHESIZE_DEFAULT_GUARDRAILS` | `strict` | `strict` / `lenient` / `off`. Caller can override per-request via `synthesisGuardrails`. |
| `SYNTHESIZE_CONCURRENCY` | `4` | Max in-flight LLM calls across synthesize requests. Each request makes 2 calls (generator + verifier in strict/lenient). |
| `OTEL_ENABLED` | `0` | Enable OpenTelemetry tracing. When `1`, exports OTLP/HTTP traces with auto-instrumentation for `http` (so OpenAI + JWKS calls show up) + `express` (Nest). The pipeline emits explicit child spans under `search`: `vector_leg`, `lexical_leg`, `route`, `ppr`, `fetch_neighbours`, `rerank` — each annotated with candidate counts. Bring-your-own backend via `OTEL_EXPORTER_OTLP_ENDPOINT` (Jaeger / Grafana Tempo / Datadog / Honeycomb all speak OTLP). Service name defaults to `inite-brain-service`; override via `OTEL_SERVICE_NAME`. No-op when off — zero cost. |

### Retrieval feature flags

The search pipeline ships every feature OFF by default and asks operators to opt in once they've measured impact on their tenant shape. Each flag is a single boolean / numeric env var; flipping it is a service restart, not a schema change.

| Flag | Default | What it does | When to enable |
|---|---|---|---|
| `SEARCH_HYPE_ENABLED` | `0` | At ingest, generates a hypothetical-question embedding alongside the literal-object embedding. Search takes `max(cos_main, cos_alt)`. Closes the question→statement gap without an LLM call on the read path. Costs +1 LLM + 1 embed per fact at ingest time. | Question-shaped queries dominate (chat / NL search). Skip for pure-id lookup workloads. |
| `SEARCH_PREDICATE_ROUTER_ENABLED` | `0` | Joint LLM call per query that emits a soft distribution over predicates AND target entity types. Boosts facts whose predicate matches the query's intent class; type prior gets piped into the reranker prompt. Cached by query hash (LRU 500). | Predicate-class confusion in the eval (`tier upgrade` vs `complained_about` matches). Cheap once the cache warms. |
| `SEARCH_CROSS_ENCODER_ENABLED` | `0` | Cohere Rerank v3.5 (or compatible) cross-encoder between fusion and the LLM stage. Reorders a wide window (default 50) and feeds the narrow top-20 to the LLM stage; pre-prunes for the LLM stage so its prompt stays small. Tracked via `brain_search_cross_encoder_total{outcome}`. Identity-fallback on any error — search never breaks because the cross-encoder hiccupped. Requires `COHERE_API_KEY`. | Recall@1 plateau and / or LLM rerank cost is dominating. The cheapest precision gain in the pipeline once you have the key. |
| `SEARCH_CROSS_ENCODER_WINDOW` | `50` | Wide-window size that the cross-encoder reorders. Larger → more recall headroom, more Cohere tokens. | Long-tailed candidate distributions where the gold answer often sits beyond rank-20 from fusion alone. |
| `SEARCH_RERANKER_ENABLED` | `0` | Listwise LLM reranker (RankGPT-style, strict JSON schema) over the top-20 fused candidates. Includes 1-hop SubgraphRAG-style neighbour context per candidate. | Recall@1 plateau. The single biggest dial in the pipeline. |
| `SEARCH_RERANKER_SC_N` | `1` | Permutation Self-Consistency: runs the reranker `N` times in parallel with shuffled orderings, aggregates via Borda count. `3` is the literature default. | Run-to-run jitter on the reranker. Costs N× LLM tokens (latency ~constant via the parallel limiter). |
| `SEARCH_RERANK_SKIP_MARGIN` | `0` | Relative-gap gate: skip the reranker when `(top1 − top2) / top1 ≥ M`. Cuts LLM cost on queries where the leader is already obvious. Tracked via `brain_search_rerank_total{outcome=skipped_margin}`. | After enabling the reranker, when `invoked` rate is high and recall has headroom. Start at `0.5` and tune via the metric. See operator playbook. |
| `SEARCH_PPR_ENABLED` | `0` | Personalized PageRank prior over the candidate-entity subgraph (HippoRAG-style). 3 power iterations, α=0.85. Multiplies rankScore by `(1 + 0.5·rNorm)`. | Fat tenants (≥ ~100 entities). Hub effects amplify pathologically on small graphs — measured. |
| `SEARCH_PPR_AUTO_THRESHOLD` | `0` | Auto-enables PPR when the candidate set ≥ N. Cheap proxy for tenant size — if the query already retrieved many candidates the graph is dense enough to support PPR. | Mixed-tenancy deployment (fat + lean tenants on the same service). Set `~50` and let it gate per-query. |
| `COMPACTION_HOT_RETENTION_DAYS` | `90` | Days kept in the searchable hot tier before compaction strips embedding + indexes. | Storage cost vs historical-search depth. |
| `COMPACTION_SUMMARIES` | `false` | Roll up compacted facts into one summary per `(entityId, predicate)` cluster. The summary keeps a fresh embedding and is searchable. | Long-history tenants where the warm tier needs to stay queryable. |

### Boot-time validation

The service runs `validateEnv()` before NestJS starts. Missing or malformed values produce a single multi-line error and exit code 1. This is intentional — better to refuse to start than to dribble out 500s under load.

### Graceful shutdown

`SIGTERM` and `SIGINT` close the SurrealDB connection and drain in-flight requests. A 15s deadline guards against a hung shutdown so docker / fly / k8s don't `SIGKILL` you with no log line.

### Tests

| Command | What it does | When to run |
|---|---|---|
| `pnpm test:e2e` | testcontainers SurrealDB + in-process NestJS app + stub embedder/extractor | every commit (CI runs this on push) |
| `pnpm test:e2e:real` | spawns brain as a separate node process, hits it via `@inite/knowledge` SDK over HTTP, MCP client roundtrip, **real OpenAI** | manual / pre-release; needs `OPENAI_API_KEY` |
| `pnpm test:eval` | multi-vertical retrieval + memory-lifecycle eval; hard-thresholds enforced (recall@1 ≥ 0.6, MRR ≥ 0.5, memory-lifecycle-correctness = 1.0, …) | post-merge to main (CI gates), pre-release |
| `pnpm test:eval:fat` | spawns a ~500-customer tenant via the generator and asserts retrieval thresholds at scale (FAT_TENANT_RUN=1 implied) | when you've changed retrieval scoring and need to confirm the small-graph regression is gone |
| `pnpm test:eval:directory` | jumbo eval — 1k customers with retracts, GDPR forgets, temporal tier trajectories, competing status; asserts memory-lifecycle correctness AND recall@3 at scale | when you've touched ingest / lifecycle code; before signing off on a release |
| `pnpm test:eval:json` | loads a directory from `BRAIN_DIRECTORY_JSON=…/file.json` and runs retrieval + lifecycle assertions; same runner, your data | bringing up brain on a real customer dataset; smoke-testing a CSV→JSON export against the eval harness |
| `pnpm lint` | ESLint flat config | every commit |

### Docker

```bash
docker compose --env-file .env up -d
curl http://localhost:${BRAIN_HOST_PORT:-3030}/health
```

The host port defaults to `3030` to avoid conflict with common dev ports; override with `BRAIN_HOST_PORT`.

The schema is reapplied per request via `DEFINE … IF NOT EXISTS` — restarts and version upgrades are idempotent.

## Eval harness

`test/eval/` is the production gate, not a smoke folder. It runs against a
spawned brain process with real OpenAI, against ~250 retrieval queries plus
3 synthesize scenarios, and asserts hard thresholds per vertical AND overall.

Layout:

```
test/eval/
├── scenarios/        # 11 declarative .scenarios.ts files + Allen-relation matrix
├── fixtures/         # fat-tenant generator + wikidata Russian-writers (Latin + Cyrillic)
├── loaders/          # JsonDirectory loader + Wikidata SPARQL mapper + query-bank generator
├── metrics/          # recall@k, MRR, NDCG, joint-F1, faithfulness, MIA-AUC,
│                     #   identity-resolution (B³), bootstrap CI
├── runner/           # SetupApplier, QueryExecutor, MemoryAssertions,
│                     #   MiaChecker, FaithfulnessChecker, Aggregator, Reporter
└── types.ts
```

Reported per-run:

- **Per-vertical + overall** for recall@1/3, MRR, NDCG@10
- **Bootstrap 95% CI** on every retrieval metric (1000 resamples, seeded mulberry32 — CI itself is reproducible)
- **Per-predicate breakdown** — surfaces "router weak on dob" that overall=0.95 hides
- **Temporal / current split** — partitioned by whether the query carried `asOf`; null on empty partition (not 0)
- **Identity-resolution F1 / precision / recall** (B³-style with declared distractors; placebo `rate(merged)` retired)
- **Faithfulness mean + pass-rate + verifier-failures** — RAGAS claim-decomposition; sourceFacts fall back to retrieved-context when emitted citations are thin
- **MIA-AUC** with underpowered guard — auto-bypasses gate when N_pos+N_neg < 30 (default `MIA_MIN_N`)
- **Memory-lifecycle correctness** — update / supersede / retract / forget assertions; threshold = 1.0
- **PII-gating correctness** — fact-level absence assertions; threshold = 1.0

Wired into CI via `actions/cache@v4` baseline. Each green push to main writes
a fresh `.eval-baseline/main.json`; PR / dispatch runs diff against the most
recent baseline and fail on regression beyond per-metric tolerance
(`scripts/eval-baseline-diff.ts`):

```
recall/MRR/NDCG/F1     >3pp drop  → block
extraction-*           >5pp drop  → block
identity / pii-gating  >1pp drop  → block
memory-lifecycle       any drop   → block (must equal 1.0)
MIA-AUC                >5pp rise  → block (lower is better)
others                 >5pp drop  → block
```

`pnpm test:eval` runs the full suite locally. Set `BRAIN_EVAL_DIRECTORY_DISABLE=1`
to skip the wikidata legs for fast-iteration loops; default behaviour pulls in
`wd-russian-writers.json` + `wd-russian-writers-ru.json` and samples 30 entities
(seed=42, deterministic) × 3 query templates per directory.

## License

UNLICENSED — internal INITE ecosystem service.
