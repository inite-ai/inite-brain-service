# Operations

Required + optional env vars, retrieval feature flags, queue tuning,
boot validation, graceful shutdown, test commands.

## Required env vars

| Var | Notes |
|---|---|
| `SURREALDB_URL` | `ws://` / `wss://` (or `http(s)://`) |
| `SURREALDB_USERNAME` / `SURREALDB_PASSWORD` | Root credentials for the DB. |
| `OPENAI_API_KEY` | `sk-...` — used for embeddings + LLM extraction. |
| `BRAIN_API_KEYS` | JSON array of `{ keyHash, companyId, scopes }`. Plaintext keys are NEVER stored — `keyHash` is `sha256:<hex>` of the plaintext you give a caller. |
| `FORGET_HMAC_KEY` | Secret used to HMAC-hash entity ids in `forgotten_entity` tombstones. **MUST be set in production** — using the default lets anyone forge tombstone hashes. Validation hard-fails the service in `NODE_ENV=production` when missing. |

## Optional env vars

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
| `DREAMS_ENABLED` | `0` | Master switch for the daily dreams cron. Each sub-op has its own gate (`DREAMS_DEDUP_ENABLED`, `DREAMS_RESOLVE_ENABLED`, `DREAMS_LLM_SUMMARY_ENABLED`). Manual `POST /v1/dreams/run` works regardless of this flag. |
| `DREAMS_DEDUP_ENABLED` | `0` | Enable near-duplicate entity finder (cosine + LLM judge). Cost: 1 cosine-kNN per active-named entity (cheap) + 1 LLM call per suspect pair. Bounded by `DREAMS_DEDUP_MAX_PAIRS` (default 50). |
| `DREAMS_RESOLVE_ENABLED` | `0` | Enable competing-fact auto-resolver. Only resolves pairs aged past `DREAMS_RESOLVE_MIN_AGE_DAYS` (default 7). Bounded by `DREAMS_RESOLVE_MAX_PAIRS` (default 20). |
| `DREAMS_CORROBORATE_ENABLED` | `0` | Enable fuzzy cross-source corroboration: same-(entity, predicate) active pairs from different origins, cosine ≥ `DREAMS_CORROBORATE_COSINE_THRESHOLD` (0.9), LLM confirms same assertion → younger row becomes `corroborating`, incumbent's counter bumped with the 0051 origin-dedup shape. Only `bitemporal`-semantics predicates; exact-equal objects skip the LLM. Bounded by `DREAMS_CORROBORATE_MAX_PAIRS` (default 20). |
| `DREAMS_LLM_SUMMARY_ENABLED` | `0` | Swap the compaction summary generator from concat to LLM-backed. The LlmSummaryGenerator falls back to concat on any LLM error, so flipping the flag is safe. |
| `COMPACTION_PROMOTION_ENABLED` | `0` | Episodic→semantic promotion, rides the compaction cron: ≥`COMPACTION_PROMOTION_MIN_GROUP` (5) active `append_only` facts per (entity, predicate), all older than `COMPACTION_PROMOTION_AGE_DAYS` (180) → one embedded `summary_<predicate>` fact (`derivedFrom` originals), originals become `compacted`. Fresh group members stay active. ≤`COMPACTION_PROMOTION_MAX_GROUPS` (20) groups/run. |
| `EMBEDDER_PROVIDER` | `openai` | `openai` (text-embedding-3-small, 1536d) or `bge-m3` (local, 1024d multilingual, ~150MB ONNX). Production ships `bge-m3` via the deploy workflow. Switching providers requires reindex (`POST /v1/admin/maintenance/reindex`) — old vectors don't match new queries. |
| `BGE_M3_WORKER` | `1` | When `1` (and provider=bge-m3), runs ONNX inference inside a dedicated `worker_thread` so the main event loop keeps serving HTTP while embeds compute. `0` falls back to in-thread inference (~80-800ms event-loop pauses under concurrent embeds; tests use this). |
| `CALIBRATION_NIGHTLY_REFIT` | `true` | Master switch for the nightly source-trust refit crons (03:42 enqueue / 03:51 inline). Enabled ONLY on literal `true` — any other value disables. |
| `SEARCH_TRUST_BETA` | `0` | fact_trust in ranking (source-reputation Phase 5): search scores ×= `1 + β·(sourceReputation − 0.5)` from the write-time trust snapshot. `0` = byte-identical ranking; snapshot-less facts sit on the neutral 0.5 at any β. |
| `SEARCH_CORROBORATION_GAMMA` | `0` | Search scores ×= `1 + γ·min(corroborationCount, 3)` — independently confirmed facts rank higher. `0` = off. |
| `SEARCH_AUTHORITY_DELTA` | `0` | Search scores ×= `1 + δ·authority` from the registry-declared source authority in the write-time trust snapshot. Facts from unregistered sources (authority 0) are unaffected at any δ. `0` = off. |
| `SEARCH_USAGE_RECORDING_ENABLED` | `0` | Stamp the facts each search surfaces into `fact_usage` (readCount + lastReadAt), fire-and-forget after the response. Prerequisite for usage-aware decay — enable this first and let usage accumulate. |
| `SEARCH_USAGE_DECAY_ENABLED` | `0` | Restart the ranking decay clock at `max(recordedAt, lastReadAt)` — facts that keep getting retrieved stay fresh. Off (or no usage row) = decay from `recordedAt`, byte-identical. |
| `SEARCH_QUERY_EXPANSION_ENABLED` | `0` | Read-side multi-query expansion: one LLM call (cached, budgeted `SEARCH_STAGE_BUDGET_QUERY_EXPANSION_MS`, default 1500) rewrites the query into `SEARCH_QUERY_EXPANSION_N` (default 2, max 4) alternative phrasings; each runs an extra vector leg, merged by max cosine. Every failure degrades to the original-query legs. Model via `SEARCH_QUERY_EXPANSION_MODEL` (default `gpt-4o-mini`). |
| `SEARCH_HNSW_ENABLED` | `0` | Approximate-KNN vector leg over the per-tenant HNSW indexes (create first: `POST /v1/admin/maintenance/hnsw`, per tenant, after any embedder reindex). Tenants without indexes soft-fall back to the exact full scan, so the flag is safe to flip globally mid-rollout. `SEARCH_HNSW_OVERFETCH` (4) × k candidates are pulled before WHERE filters (KNN filters post-hoc); `SEARCH_HNSW_EF` (100) is the search width. Re-run the quality eval after enabling — approximate recall is a trade. Worth it past ~50k active facts per tenant. |
| `SYNTHESIZE_MIN_FACT_TRUST` | `0` | Citation floor on write-time source reputation (beside `SYNTHESIZE_MIN_CONFIDENCE`). `0` = off; floors ≤ 0.5 never drop unscored facts. |
| `DOCUMENT_INGEST_ENABLED` | `0` | Master switch for the [document pipeline](document-pipeline.md) (`POST /v1/ingest/document` + `/v1/documents/*`). Off = every route answers 503 and the legacy mention/fact paths behave byte-identically. |
| `DOCUMENT_MULTI_INDEXER_ENABLED` | `0` | Dedicated per-pack indexer runs + relevance router + async (queue-driven) document ingest. Off = only the `'_general'` union pass runs. |
| `REINDEX_ON_PACK_INSTALL` | `0` | Enqueue a pack-scoped backfill over stored documents at the end of every pack install/upgrade. |
| `INGEST_MENTION_VIA_DOCUMENT` | `0` | Route `POST /v1/ingest/mention` through the document pipeline (response contract preserved). Off = legacy mention path, untouched. |
| `DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL` | `0` | Allow external indexers to stage candidates against `storeContent:false` documents. Off = rejected — with no stored text there is nothing to re-ground against, so spans are unverifiable (arbitrary fact fabrication). Opt-in only. |
| `DOC_MAX_CHARS` / `DOC_CHUNK_TARGET_CHARS` | `512000` / `12000` | Document size cap (413 above; enforced on both the REST and MCP `ingest_document` paths) and chunker target (hard max 16K = the extractor clamp). |
| `CANDIDATE_MIN_CONFIDENCE` | `0` | Brain-side prefilter: merged facts below this never reach the resolver. |
| `CANDIDATE_RETENTION_DAYS` / `CANDIDATE_PENDING_TTL_DAYS` | `30` / `7` | Nightly candidate sweeper: delete decided rows after / expire stuck pending rows after. |
| `REINDEX_MAX_DOCS_PER_RUN` | `500` | Backfill batch budget per `reindex_documents` job (batches self-chain). |
| `MAX_DEDICATED_INDEXERS_PER_DOC` | `8` | Upper bound on dedicated indexers a single document routes to (LLM fan-out = chunks × packs × sc-passes). Router keeps the most relevant; the drop is logged. |
| `INDEXER_RUN_STALE_MINUTES` | `30` | How long an `indexer_run` may sit `running` before the nightly sweep reaps it as crashed (unblocking a wedged commit). Must exceed the job lease (600s) + longest extraction. |
| `DOMAIN_PACK_TRUSTED_KEYS` | unset | Pack-install trust store: JSON object mapping `publisher` → ed25519 PEM public key. Malformed JSON fails boot (env validation) — a typo would silently empty the store and every signed pack would fail as "unknown publisher". |
| `DOMAIN_PACK_REQUIRE_SIGNATURE` | `0` | When `1`/`true`, `POST /v1/admin/packs` rejects unsigned manifests. Values outside `1/0/true/false` fail boot — an unrecognized value would silently disable enforcement. |
| `PACK_REGISTRY_REQUIRE_SIGNATURE` | `0` | Same policy for `POST /v1/admin/registry/packs` (publish into the global catalogue). Same strict value set. |
| `OTEL_ENABLED` | `0` | Enable OpenTelemetry tracing. When `1`, exports OTLP/HTTP traces with auto-instrumentation for `http` (so OpenAI + JWKS calls show up) + `express` (Nest). The pipeline emits explicit child spans under `search`: `vector_leg`, `lexical_leg`, `route`, `ppr`, `fetch_neighbours`, `rerank` — each annotated with candidate counts. Plus Phase K3 queue handoff spans: `jobs.enqueue` (PRODUCER) + `jobs.process <jobType>` (CONSUMER, linked via traceparent on the row). Bring-your-own backend via `OTEL_EXPORTER_OTLP_ENDPOINT`. Service name defaults to `inite-brain-service`; override via `OTEL_SERVICE_NAME`. No-op when off — zero cost. |

## Job queue (Phase J/K) — env vars

The queue is on by default. Every var has a safe default; tune below.

| Var | Default | Notes |
|---|---|---|
| `JOBS_QUEUE_MODE` | `enqueue` | `enqueue` (queue mode) or `inline` (legacy guarded inline path — kill switch). Set + restart to roll back queue mode without a redeploy. |
| `WORKER_LOOP_ENABLED` | `1` | Master switch for the per-pod worker loop. Set `0` to disable claim/dispatch entirely (cron still enqueues; rows stay pending). |
| `WORKER_LOOP_POLL_MS` | `1000` | Inter-cycle sleep between claim attempts. Tighter → faster pickup, more Surreal load. |
| `WORKER_LOOP_EMPTY_BACKOFF_MS` | `5000` | Sleep when the queue is empty across every known tenant. Prevents idle pods from hammering Surreal. |
| `WORKER_LOOP_LEASE_RENEW_MS` | `30000` | How often `worker_loop` leader lease is re-acquired. Lease ttl is 3× this — a crashed leader's lease expires in ~90s. |
| `LEASE_MANAGER_ENABLED` | `1` | Master switch for the housekeeping cron (zombie reaper every 10s + stale-lease janitor every 60s). |
| `JOB_RUN_MAX_ATTEMPTS` | `3` | After this many failures the row goes terminal-fail instead of requeueing. |
| `JOB_RUN_BACKOFF_BASE_MS` | `30000` | Exponential-backoff base for failed/zombie-reaped jobs. Cap is 1h regardless of base × `2^(attempts-1)`. |
| `JOB_WORKER_POOL_SIZE` | `2` (dev) / `0` (prod) | `node:worker_threads` pool size for `cpuBound: true` handlers. `0` disables the pool entirely (no current handler is cpuBound). |
| `JOB_RUN_PERSIST` | `1` | Set `0` only in unit tests to disable job_run persistence entirely. Never in prod. |

## Retrieval feature flags

The search pipeline ships every feature OFF by default and asks
operators to opt in once they've measured impact on their tenant
shape. Each flag is a single boolean / numeric env var; flipping it is
a service restart, not a schema change.

| Flag | Default | What it does | When to enable |
|---|---|---|---|
| `SEARCH_HYPE_ENABLED` | `0` | At ingest, generates a hypothetical-question embedding alongside the literal-object embedding. Search takes `max(cos_main, cos_alt)`. Closes the question→statement gap without an LLM call on the read path. Costs +1 LLM + 1 embed per fact at ingest time. | Question-shaped queries dominate (chat / NL search). Skip for pure-id lookup workloads. |
| `SEARCH_PREDICATE_ROUTER_ENABLED` | `0` | Joint LLM call per query that emits a soft distribution over predicates AND target entity types. Boosts facts whose predicate matches the query's intent class; type prior gets piped into the reranker prompt. Cached by query hash (LRU 500). | Predicate-class confusion in the eval (`tier upgrade` vs `complained_about` matches). Cheap once the cache warms. |
| `SEARCH_CROSS_ENCODER_ENABLED` | `0` | Cohere Rerank v3.5 (or compatible) cross-encoder between fusion and the LLM stage. Reorders a wide window (default 50) and feeds the narrow top-20 to the LLM stage; pre-prunes for the LLM stage so its prompt stays small. Tracked via `brain_search_cross_encoder_total{outcome}`. Identity-fallback on any error — search never breaks because the cross-encoder hiccupped. Requires `COHERE_API_KEY`. | Recall@1 plateau and / or LLM rerank cost is dominating. The cheapest precision gain in the pipeline once you have the key. |
| `SEARCH_CROSS_ENCODER_WINDOW` | `50` | Wide-window size that the cross-encoder reorders. Larger → more recall headroom, more Cohere tokens. | Long-tailed candidate distributions where the gold answer often sits beyond rank-20 from fusion alone. |
| `SEARCH_CROSS_ENCODER_LOCAL` | `0` | No-vendor fallback: run a cross-encoder locally via `@xenova/transformers` (ONNX) when `COHERE_API_KEY` is absent. Inference runs in a `worker_thread` (never blocks the event loop); model is ~279MB (set `TRANSFORMERS_CACHE` so it survives restarts). `SEARCH_CROSS_ENCODER_LOCAL_MODEL` (default `Xenova/bge-reranker-base`), `SEARCH_CROSS_ENCODER_LOCAL_WORKER=0` forces in-thread. | A self-hoster with no rerank vendor who still wants joint-encoder precision. |
| `SEARCH_CROSS_ENCODER_LOCAL_WINDOW` | `20` | Window the LOCAL path reranks (it scores pairs sequentially, so it uses a tighter window than Cohere's `_WINDOW`). Bounded by the stage budget. | Rarely — raise only if local rerank latency is comfortably under `SEARCH_STAGE_BUDGET_CROSS_ENCODER_MS`. |
| `SEARCH_RERANKER_ENABLED` | `0` | Listwise LLM reranker (RankGPT-style, strict JSON schema) over the top-20 fused candidates. Includes 1-hop SubgraphRAG-style neighbour context per candidate. | Recall@1 plateau. The single biggest dial in the pipeline. |
| `SEARCH_RERANKER_SC_N` | `1` | Permutation Self-Consistency: runs the reranker `N` times in parallel with shuffled orderings, aggregates via Borda count. `3` is the literature default. | Run-to-run jitter on the reranker. Costs N× LLM tokens (latency ~constant via the parallel limiter). |
| `SEARCH_RERANK_SKIP_MARGIN` | `0` | Relative-gap gate: skip the reranker when `(top1 − top2) / top1 ≥ M`. Cuts LLM cost on queries where the leader is already obvious. Tracked via `brain_search_rerank_total{outcome=skipped_margin}`. | After enabling the reranker, when `invoked` rate is high and recall has headroom. Start at `0.5` and tune via the metric. See operator playbook. |
| `SEARCH_PPR_ENABLED` | `0` | Personalized PageRank prior over the candidate-entity subgraph (HippoRAG-style). 3 power iterations, α=0.85. Multiplies rankScore by `(1 + 0.5·rNorm)`. | Fat tenants (≥ ~100 entities). Hub effects amplify pathologically on small graphs — measured. |
| `SEARCH_PPR_AUTO_THRESHOLD` | `0` | Auto-enables PPR when the candidate set ≥ N. Cheap proxy for tenant size — if the query already retrieved many candidates the graph is dense enough to support PPR. | Mixed-tenancy deployment (fat + lean tenants on the same service). Set `~50` and let it gate per-query. |
| `COMPACTION_HOT_RETENTION_DAYS` | `90` | Days kept in the searchable hot tier before compaction strips embedding + indexes. | Storage cost vs historical-search depth. |
| `COMPACTION_SUMMARIES` | `false` | Roll up compacted facts into one summary per `(entityId, predicate)` cluster. The summary keeps a fresh embedding and is searchable. | Long-history tenants where the warm tier needs to stay queryable. |

## Boot-time validation

The service runs `validateEnv()` before NestJS starts. Missing or
malformed values produce a single multi-line error and exit code 1.
This is intentional — better to refuse to start than to dribble out
500s under load.

## Graceful shutdown

`SIGTERM` and `SIGINT` close the SurrealDB connection and drain in-
flight requests. A 15s deadline guards against a hung shutdown so
docker / fly / k8s don't `SIGKILL` you with no log line.

## Tests

| Command | What it does | When to run |
|---|---|---|
| `pnpm test` | Jest unit suite — fast (no Surreal container, no real OpenAI). | Every commit (CI runs this on push). |
| `pnpm test:e2e` | testcontainers SurrealDB + in-process NestJS app + stub embedder/extractor. | Every commit (CI runs this on push). |
| `pnpm test:e2e:real` | Spawns brain as a separate node process, hits it via `@inite/knowledge` SDK over HTTP, MCP client roundtrip, **real OpenAI**. | Manual / pre-release; needs `OPENAI_API_KEY`. |
| `pnpm test:eval` | Multi-vertical retrieval + memory-lifecycle eval; hard-thresholds enforced (recall@1 ≥ 0.6, MRR ≥ 0.5, memory-lifecycle-correctness = 1.0, …). | Post-merge to main (CI gates), pre-release. |
| `pnpm test:eval:fat` | Spawns a ~500-customer tenant via the generator and asserts retrieval thresholds at scale (`FAT_TENANT_RUN=1` implied). | When you've changed retrieval scoring and need to confirm the small-graph regression is gone. |
| `pnpm test:eval:directory` | Jumbo eval — 1k customers with retracts, GDPR forgets, temporal tier trajectories, competing status; asserts memory-lifecycle correctness AND recall@3 at scale. | When you've touched ingest / lifecycle code; before signing off on a release. |
| `pnpm test:eval:json` | Loads a directory from `BRAIN_DIRECTORY_JSON=…/file.json` and runs retrieval + lifecycle assertions; same runner, your data. | Bringing up brain on a real customer dataset; smoke-testing a CSV→JSON export against the eval harness. |
| `pnpm test --testPathPattern=jobs.real` | Real-Surreal e2e: enqueue → claim → renew → complete cycle, dedup collision, fail+requeue, zombie reap, leader_lease in `system` DB. | After touching anything in `src/jobs/` or migrations 0028-0031. |
| `pnpm lint` | ESLint flat config. | Every commit. |
