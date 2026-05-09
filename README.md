# INITE Brain Service

Cross-vertical knowledge layer for the INITE ecosystem. **System of insight, not system of record.**

Implements [`inite.service.brain`](https://github.com/inite/inite-ecosystem/blob/main/core/services/brain.yaml) and the [`knowledge`](https://github.com/inite/inite-ecosystem/blob/main/core/capabilities/knowledge.yaml) capability bundle from `inite-ecosystem` v0.2.0-rc.4.

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

## Status — 0.1.0 walking skeleton

| Endpoint | Status |
|---|---|
| `GET /health` | ✅ |
| `POST /v1/ingest/fact` | ✅ |
| `POST /v1/search` | ✅ |
| `POST /v1/synthesize` | ✅ (corrective-RAG, opt-in via `OPENAI_API_KEY`) |
| `POST /v1/search/multi-hop` | ✅ (chained search via planner-LLM) |
| `POST /v1/ingest/mention` | planned 0.2.0 |
| `POST /v1/ingest/link` | planned 0.2.0 |
| `GET /v1/entities/:id` | planned 0.2.0 |
| `GET /v1/entities/:id/timeline` | planned 0.2.0 |
| `POST /v1/facts/:id/retract` | planned 0.2.0 |
| `POST /v1/entities/:id/forget` | planned 0.2.0 |
| `POST /mcp/:companyId` (Streamable HTTP) | planned 0.3.0 |

## Tech stack

- **NestJS 11** + TypeScript
- **SurrealDB 2** with HNSW vector index (`text-embedding-3-small`, 1536 dims)
  - Tenancy: namespace `brain`, database `co_<companyId>` per tenant
- **OpenAI** for embeddings (chat extraction lands in 0.2.0)

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

Response carries `hops[]` (per-hop sub-query + entity-id list) so callers can audit how the planner decomposed their question.

## Synthesize (corrective-RAG)

`POST /v1/synthesize` is `/v1/search` with one extra step: the retrieved facts get fed to a generator LLM that produces a grounded, citation-bearing answer (each claim ends with `[factId]`), and then a verifier LLM judges whether every claim is supported by the source facts. Three modes:

- **strict** (default) — verifier must return `supported`. Anything else (`partial` / `unsupported`) collapses to `answer: null` with a `reason` field. Fail-closed on verifier outage too.
- **lenient** — verifier still runs, but the answer is returned regardless. The verifier's verdict is exposed via `reason` so the caller can decide.
- **off** — skip verifier (cheapest; for callers that do their own grounding).

Hallucinated `factId` citations (the LLM cited an id not in the retrieved set) are filtered before the response leaves the server. The `results` field carries the raw `SearchHit[]` so callers can fall back to manual synthesis when the answer is null.

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

This enables both "what was true on date X" and "what did we know on date X" queries. Retractions never delete; they close `validUntil` and set `retractedAt`. The fact row stays for audit.

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

Each company gets its own SurrealDB database (`co_<companyId>`). Cross-tenant queries are physically impossible at the storage layer — there is no shared table with row-level security. Forgetting a tenant is `REMOVE DATABASE` (single statement).

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

## License

UNLICENSED — internal INITE ecosystem service.
