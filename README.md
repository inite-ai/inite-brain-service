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

### Retrieval feature flags

The search pipeline ships every feature OFF by default and asks operators to opt in once they've measured impact on their tenant shape. Each flag is a single boolean / numeric env var; flipping it is a service restart, not a schema change.

| Flag | Default | What it does | When to enable |
|---|---|---|---|
| `SEARCH_HYPE_ENABLED` | `0` | At ingest, generates a hypothetical-question embedding alongside the literal-object embedding. Search takes `max(cos_main, cos_alt)`. Closes the question→statement gap without an LLM call on the read path. Costs +1 LLM + 1 embed per fact at ingest time. | Question-shaped queries dominate (chat / NL search). Skip for pure-id lookup workloads. |
| `SEARCH_PREDICATE_ROUTER_ENABLED` | `0` | Joint LLM call per query that emits a soft distribution over predicates AND target entity types. Boosts facts whose predicate matches the query's intent class; type prior gets piped into the reranker prompt. Cached by query hash (LRU 500). | Predicate-class confusion in the eval (`tier upgrade` vs `complained_about` matches). Cheap once the cache warms. |
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
