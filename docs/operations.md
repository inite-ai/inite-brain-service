# Operations

Every env var and feature flag, queue tuning, the api/worker role
split, staged enablement runbooks, boot validation, and test commands —
the operator's reference for running Brain.

**Contents:**
[Required env vars](#required-env-vars) ·
[Optional env vars](#optional-env-vars) ·
[Job queue](#job-queue-phase-jk--env-vars) ·
[Splitting API and worker roles](#splitting-api-and-worker-roles) ·
[Retrieval feature flags](#retrieval-feature-flags) ·
[Enabling the document pipeline + external indexers](#enabling-the-document-pipeline--external-indexers) ·
[Enabling MCP pack tools](#enabling-mcp-pack-tools) ·
[Enabling marketplace billing](#enabling-marketplace-billing-paid-packs) ·
[Boot-time validation](#boot-time-validation) ·
[Tests](#tests)

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
| `AUTH_SERVICE_INTROSPECTION_CLIENT_ID` / `_SECRET` | unset | Enables RFC 7662 resolution of auth-service `ik_…` API keys (brain-service M2M client credentials). |
| `AUTH_SERVICE_INTROSPECTION_URL` | `AUTH_SERVICE_URL`+`/v1/oauth/introspect` | Endpoint override. |
| `AUTH_SSF_POLL_URL` | unset | CAEP revocation stream poll endpoint (RFC 8936); enables the deny-list that rejects IdP-revoked tokens before `exp`. `AUTH_SSF_CLIENT_ID/SECRET` default to the introspection client; `AUTH_SSF_POLL_SCOPE` default `admin`; `AUTH_SSF_POLL_INTERVAL_MS` default `30000`. |
| `THROTTLE_TIER_MULTIPLIERS` | unset | JSON map entitlement→rate-limit multiplier applied after credential verification, e.g. `{"plan:pro":2}`. |
| `BRAIN_PUBLIC_URL` | derived from Host | Canonical resource URL advertised in RFC 9728 metadata + WWW-Authenticate challenges. |
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
| `SEARCH_CHATTER_PENALTY` | `1.0` | Sub-1.0 ranking multiplier on low-value `said` chatter facts ("Hey!", "That's great!") so substantive facts of the same entity aren't buried. `1.0` = off; a demotion needs a value in `(0,1)`, e.g. `0.35`. |
| `INGEST_CONTEXTUAL_FACT_EMBEDDING` | `0` | Contextual fact embedding (Anthropic Contextual Retrieval, fact-level): embed each mention-extracted fact with a compact context stamp (speaker + session date) prepended to `predicate: object`, so the stored vector is closer to context-referencing queries. `0` = bare text (byte-identical embeddings). Changes the embedding basis → requires re-ingest to take effect. |
| `INGEST_EVENT_TIME_EXTRACTION` | `0` | Event-time extraction: when a mention clause carries a relative temporal expression (`yesterday`, `last year`, `3 weeks ago`, RU `вчера`/`три недели назад`), resolve the occurrence date against the message time and stamp the fact's `validFrom` with it instead of the message time — so "went to the group yesterday" (said 8 May) records the event on 7 May. Multilingual via `chrono-node`, dispatched by the clause's detected language (en/ru/fr/de/es/pt/nl/ja/…) with an English fallback; no LLM call. A clause with no resolvable expression falls back to the message time unchanged. Changes stored `validFrom` → requires re-ingest to take effect. **Prod prerequisite:** a backdated `validFrom` can make a bitemporal supersede stamp `validUntil` earlier than the incumbent's `validFrom` (inverted interval → fact hidden from `asOf`). `single_active` is guarded (out-of-order → `INSERTED_HISTORICAL`); the bitemporal path is not. Keep OFF in prod until the supersede clamps `validUntil ≥ validFrom` (or restrict event-time to episodic/append_only predicates). Safe for benchmark tenants. |
| `INGEST_BATCH_EDGES` | `0` | Batched edge persistence. Collapses a mention's per-edge `RELATE` round-trips into TWO queries — one multi-statement existence check, then one multi-statement `RELATE` for only the edges that don't already exist; a re-ingest with all edges present is a SINGLE round-trip. Same observable outcome as the per-edge loop (idempotent RELATE on `UNIQUE(in,out,kind)`, in-batch `(from,to,kind)` dedup). The existence check makes the RELATE batch collision-free in the common case; a concurrent writer creating one of the missing edges between check and RELATE trips the batch atomically → caught and redone through the per-edge idempotent primitive. `0` = per-edge loop (byte-identical). Read at boot. |
| `SEARCH_COMBINED_VECTOR_GRAPH` | `0` | Combined vector+graph retrieval — SurrealDB's native hybrid strength. Folds each fact's entity neighbourhood (`->knowledge_edge->`) into the vector KNN query as a co-equal projection, so candidate generation is ONE SurrealQL round-trip instead of a vector query plus a separate edge-expansion lookup. Edge-expansion then reuses the prefetched neighbours and only queries seeds the vector leg didn't cover. `0` = empty projection + legacy separate lookup (byte-identical). Read at boot. A latency/architecture win (fewer round-trips, DB-side traversal); ranking is unchanged. Pairs well with `SEARCH_HNSW_ENABLED` (native ANN index) at scale. |
| `SEARCH_HIGHLIGHT_ENABLED` | `0` | BM25 match snippets. The FULLTEXT indexes are defined with `HIGHLIGHTS` but `search::highlight` was never queried; when on, the lexical leg projects `search::highlight('<em>','</em>',1)` and search responses carry a `highlight` field on lexically-matched facts (matched terms wrapped in `<em>…</em>`). `0` = no `highlight` field (byte-identical payload). Read at boot. |
| `SEARCH_USAGE_RECORDING_ENABLED` | `0` | Stamp the facts each search surfaces into `fact_usage` (readCount + lastReadAt), fire-and-forget after the response. Prerequisite for usage-aware decay — enable this first and let usage accumulate. |
| `SEARCH_USAGE_DECAY_ENABLED` | `0` | Restart the ranking decay clock at `max(recordedAt, lastReadAt)` — facts that keep getting retrieved stay fresh. Off (or no usage row) = decay from `recordedAt`, byte-identical. |
| `SEARCH_HNSW_ENABLED` | `0` | Approximate-KNN vector leg over the per-tenant HNSW indexes (create first: `POST /v1/admin/maintenance/hnsw`, per tenant, after any embedder reindex). Tenants without indexes soft-fall back to the exact full scan, so the flag is safe to flip globally mid-rollout. `SEARCH_HNSW_OVERFETCH` (4) × k candidates are pulled before WHERE filters (KNN filters post-hoc); `SEARCH_HNSW_EF` (100) is the search width. Re-run the quality eval after enabling — approximate recall is a trade. Worth it past ~50k active facts per tenant. |
| `INGEST_INLINE_RESOLUTION_HNSW` | `0` | Route the inline entity-resolution name-candidate scan through the same per-tenant HNSW index instead of a full cosine scan of every `name` fact on each inline resolution. Over-fetches `INGEST_INLINE_RESOLUTION_HNSW_OVERFETCH` (8) × k candidates before the name/type WHERE (KNN filters post-hoc); `INGEST_INLINE_RESOLUTION_HNSW_EF` (100) is the search width. Tenants without the index soft-fall back to the full scan. Only active when `INGEST_INLINE_RESOLUTION_ENABLED` is also on. **Correctness gate:** a missed approximate candidate creates a DUPLICATE entity (not just lower recall like search) — before enabling per tenant, run the dedup/quality eval and confirm the HNSW path finds every candidate the full scan does. Higher default over-fetch than search (8 vs 4) because `name` facts are a small fraction of all facts; a name-query embedding is near other name facts, but verify per corpus. |
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
| `INDEXER_RUN_STALE_MINUTES` | `30` | How long an `indexer_run` may sit `running` before the nightly sweep reaps it as crashed (unblocking a wedged commit). Must exceed the job lease (600s) + longest extraction. Also the external work-claim lease (heartbeat renews; expired claims release back to `pending`). |
| `INDEXER_EXTERNAL_PENDING_TTL_DAYS` | `7` | How long an unclaimed external work item (`pending` external `indexer_run`, served by `GET /v1/indexer/work`) stays pollable before the nightly sweep expires it. |
| `ABAC_ENABLED` | `0` | Master switch for [per-key ABAC policies](abac.md) (migration 0056). Off = the resolver never runs, byte-identical behavior. On = keys referencing policy sets get action-level gating (REST + MCP tools) and row-level read filtering; keys without policies stay unchanged. Values outside `1/0/true/false` fail boot. |
| `ABAC_FORCE_REPORT_ONLY` | `0` | Emergency demote-all: every enforce-mode policy set behaves as report_only (decisions logged, nothing blocked). The rollback lever for a bad policy. Same strict value set. |
| `POLICY_CACHE_TTL_MS` / `POLICY_CACHE_CAP` | `60000` / `500` | Per-tenant compiled-policy snapshot cache. CRUD invalidates in-process; other instances converge within the TTL (document the staleness bound to tenants). Cap = tenants held in the LRU. |
| `POLICY_DECISION_SAMPLE_RATE` | `0.01` | `policy_decision` stream sampling for enforce-mode *allows*. Denies and report_only divergences are always written. |
| `POLICY_DECISION_RETENTION_DAYS` | `30` | Decision rows older than this are pruned lazily on flush (at most once per 6 h per tenant). |
| `SOURCE_META_STRICT` | `0` | Document `meta` / direct-fact `metadata` is sanitized (snake_case keys, short scalars, ≤16) before landing as ABAC-matchable `source.meta` on facts. Off = drop-and-warn; on = the ingest answers 400 `invalid_meta` — a silently-dropped `data_class` would silently widen access. |
| `ABAC_DB_FENCE_ENABLED` | `0` | Binds the request's pushdown-safe deny rules to `$caller_policy_deny` on scoped connections for the 0057 field-PERMISSIONS fence. **Currently inert**: SurrealDB skips PERMISSIONS for the `brain_caller` system user (same applies to the 0005 PII fence) — see the finding in [`docs/abac.md`](abac.md#db-level-fence-status-migration-0057) and the canary in `test/abac-db-fence.e2e-spec.ts`. Keep off until callers move to record users. |
| `POLICY_META_UNION_ENABLED` | `0` | Effective-meta union: corroborated facts also inherit their confirming documents' meta for DENY evaluation (most-restrictive union, Zep's episode-union equivalent). One batched `contentHash` lookup per request behind a 10k/5min process LRU; applies on search fusion + `graph_retrieve` (supplementary legs evaluate own-meta only). Facts committed before the projection: run `POST /v1/admin/policy-sets/backfill-meta` until `remaining=0`. |
| `DOMAIN_PACK_TRUSTED_KEYS` | unset | Pack-install trust store: JSON object mapping `publisher` → ed25519 PEM public key. Malformed JSON fails boot (env validation) — a typo would silently empty the store and every signed pack would fail as "unknown publisher". |
| `DOMAIN_PACK_REQUIRE_SIGNATURE` | `0` | When `1`/`true`, `POST /v1/admin/packs` rejects unsigned manifests. Values outside `1/0/true/false` fail boot — an unrecognized value would silently disable enforcement. |
| `PACK_REGISTRY_REQUIRE_SIGNATURE` | `0` | Same policy for `POST /v1/admin/registry/packs` (publish into the global catalogue). Same strict value set. |
| `PACK_SEED_INGEST_ENABLED` | `1` | Ingest a pack's `seedDocuments` through the document pipeline on install (`pack_seed_ingest` job). Requires `DOCUMENT_INGEST_ENABLED`; when either is off the install response reports a skip — install never fails because of seeds. |
| `INDEXER_WEBHOOK_PUSH_ENABLED` | `1` | Signed `work_available` webhook hints to external packs declaring `indexer.external.callbackUrl`. Best-effort (retries + per-URL circuit breaker; `INDEXER_WEBHOOK_RETRY_BASE_MS` tunes backoff); polling stays the source of truth. |
| `REGISTRY_UPSTREAM_URL` | unset | Pull-only registry mirroring: pull the upstream catalogue and republish missing versions locally through the normal publish path. Unset = off, no job registered. Optional `REGISTRY_UPSTREAM_TOKEN` (a `brain:read` key on the upstream); cadence via `REGISTRY_MIRROR_INTERVAL_HOURS` (default 24). |
| `MCP_PACK_TOOLS_ENABLED` | `0` | Master switch for [pack-declared MCP tools](mcp-pack-tools.md). Off = the MCP surface is exactly the static tool families. Sub-flags: `MCP_PACK_QUERY_TOOLS_ENABLED` (default `1`), `MCP_PACK_EXTERNAL_TOOLS_ENABLED` (default `0`), `MCP_PACK_TOOLS_ALLOW_HTTP` (dev/test ONLY — disables the SSRF egress guard), `MCP_PACK_TOOLS_CACHE_TTL_MS` (default 30000). |
| `DOMAIN_PACK_BILLING_ENABLED` | `0` | Paid packs via the central billing service — see [Enabling marketplace billing](#enabling-marketplace-billing-paid-packs). Off (the self-hosted posture) = pricing metadata is ignored, every pack installs free. Requires `BILLING_SERVICE_URL` + `BILLING_SERVICE_API_KEY` when on (boot-validated); `BILLING_TIMEOUT_MS` / `BILLING_ENTITLEMENT_CACHE_TTL_MS` tune the client. |
| `OTEL_ENABLED` | `0` | Enable OpenTelemetry tracing. When `1`, exports OTLP/HTTP traces with auto-instrumentation for `http` (so OpenAI + JWKS calls show up) + `express` (Nest). The pipeline emits explicit child spans under `search`: `vector_leg`, `lexical_leg`, `route`, `ppr`, `fetch_neighbours`, `rerank` — each annotated with candidate counts. Plus Phase K3 queue handoff spans: `jobs.enqueue` (PRODUCER) + `jobs.process <jobType>` (CONSUMER, linked via traceparent on the row). Bring-your-own backend via `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL, no path — the exporter appends `/v1/traces`; prod points it at the monitoring stack's Alloy, see `monitoring/README.md`). Service name defaults to `inite-brain-service`; override via `OTEL_SERVICE_NAME`. No-op when off — zero cost. |

Prod observability (metrics scrape, log shipping, trace storage,
Grafana dashboards + alert rules) is the `monitoring/` compose stack on
the droplet — entry point [`monitoring/README.md`](../monitoring/README.md),
Grafana at `https://brain.inite.ai/grafana`.

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
| `WORKER_LOOP_MAX_CONCURRENT` | `1` | In-flight dispatch bound per job type on this pod. Override per type with `WORKER_LOOP_MAX_CONCURRENT_<JOBTYPE>` (job type upper-cased, e.g. `WORKER_LOOP_MAX_CONCURRENT_DREAMS=2`, `WORKER_LOOP_MAX_CONCURRENT_INDEX_DOCUMENT=2`). `WORKER_LOOP_TENANT_MAX_CONCURRENT` (default 1) bounds per-tenant fan-out; `WORKER_LOOP_GLOBAL_MAX_CONCURRENT` (default 0 = unbounded) caps the pod total. |
| `PROCESS_ROLE` | `all` | One-env role split: `all` / `api` / `worker`. Maps to the flag bundle described in [Splitting API and worker roles](#splitting-api-and-worker-roles). Explicitly-set flags always win over the role defaults. |

## Splitting API and worker roles

By default one Node process does everything: HTTP API, crons, the
job_run queue loop, and the `worker_threads` pool. `PROCESS_ROLE`
bundles the existing split machinery (worker-loop kill switch, leader
leases, dedupKey-idempotent cron enqueues) behind a single env so you
can run one HTTP-only pod and one jobs pod against the same SurrealDB.

### Role semantics

Applied at boot, **before** Nest module init, and only for flags you
did NOT set explicitly — an explicit env always wins over the role
default. Each applied (or skipped-because-explicit) default is logged
under the `ProcessRole` context.

| Role | Flag defaults applied | Meaning |
|---|---|---|
| `all` (default) | none | Byte-identical single-process behavior. |
| `api` | `WORKER_LOOP_ENABLED=0`, `JOB_WORKER_POOL_SIZE=0` | Serves HTTP; never claims/dispatches queued jobs; skips the `worker_threads` job pool (it serves cpuBound *job* handlers only — nothing on the request path uses it). |
| `worker` | `CHAT_ROUTE_NLI_ENABLED=false` | Runs the queue loop + crons. Keeps the HTTP server up (healthcheck + `/v1/admin/*` need it) but the compose recipe publishes no ports. Skips the ~135MB NLI intent-classifier ONNX model — a worker pod doesn't chat-route. |

**`JOBS_QUEUE_MODE=enqueue` is required** (it is the default):
`PROCESS_ROLE=api|worker` combined with `JOBS_QUEUE_MODE=inline` fails
boot-time validation — inline mode executes compaction/dreams/refit
inside whatever process fired the cron, which defeats the split.

### What still runs on an api-role pod

`@Cron` registrations are not gated by `WORKER_LOOP_ENABLED`, so the
api pod still fires them — by design, all of them are either
enqueue-only or lease-arbitrated:

- **Enqueue-only nightly crons** (compaction 03:17, calibration/source-
  trust refit 03:42/03:51, candidate sweeper 03:45, dreams 04:00): in queue
  mode they only insert `job_run` rows with date-keyed dedupKeys; the
  rows sit pending until the worker pod's loop claims them. Double
  firing across pods collapses on the UNIQUE(jobType, dedupKey) index.
- **Memory-quality gauge cron (03:35)**: computes per-pod Prometheus
  gauges locally on every pod — intentionally lease-less.
- **Changefeed consumer (every minute, off by default)** and the
  **lease-manager janitor (10s/60s)**: gated by leader leases, so ONE
  pod runs them — and that can be the api pod if it wins the lease.
  Both are light (IO-bound drain / zombie-reap writes). To pin them to
  the worker, set `AUDIT_CHANGEFEED_ENABLED=0` /
  `LEASE_MANAGER_ENABLED=0` explicitly on the api pod.

The worker pod runs everything: queue loop (it should win the
`worker_loop` lease since the api pod no longer competes), all crons,
and the cpuBound `worker_threads` pool.

### Compose recipe

`docker-compose.yml` ships an opt-in `brain-worker` service under the
`split` profile. Uncomment `PROCESS_ROLE=api` on the `brain` service,
then:

```bash
docker compose --profile split up -d
```

Default `docker compose up` is unchanged — the profile keeps the
worker service out of the single-process deployment.

### Memory notes

- A second pod is a second full Node + Nest RSS (~200-300MB baseline
  before models) plus its own SurrealDB connection pool
  (`SURREALDB_POOL_SIZE` per pod). Budget both against the host.
- ONNX models lazy-load where used: the NLI intent classifier (~135MB)
  loads only where chat routing runs (api pod; disabled on worker by
  the role default), the local cross-encoder (~279MB, opt-in) only
  where search runs. The BGE-M3 embedder (~150MB, when
  `EMBEDDER_PROVIDER=bge-m3`) loads on BOTH pods — the api pod embeds
  queries, the worker embeds ingested facts.

### When to actually split

Stay single-process until at least one of these holds:

- **≥4 CPUs** available — below that the two pods just contend.
- **p95 event-loop lag** on the API during the nightly cron window
  (03:00-05:00 UTC) — the queue work is starving request latency.
- **HA / ≥2 pods**: you are scaling the API horizontally anyway; give
  every API pod `PROCESS_ROLE=api` and run exactly one (or a few —
  leases arbitrate) `PROCESS_ROLE=worker` pod.

## Retrieval profile (per-tenant configuration)

The genre-dependent retrieval dimensions are NOT feature flags — they
are per-tenant configuration, resolved once per request into a
`RetrievalProfile` object (the platform directive 2026-08-03 replaced
the old per-lane flag forks with this surface). Env sets the boot
default; `RETRIEVAL_PROFILE_OVERRIDES` overlays per tenant.

| Key | Default | What it does |
|---|---|---|
| `RETRIEVAL_GENRE` | `assistant_chat` | Names the corpus shape (`dialogue` \| `assistant_chat` \| `documents`) so per-tenant overrides read as intent. The dimensions the engine actually branches on are the two below. |
| `RETRIEVAL_VERBATIM_EVIDENCE` | `shape_conditioned` | How verbatim L0 evidence reaches answers: `off` (facts only), `shape_conditioned` (episode quotes + provenance excerpts only when the question asks for conversational content — the engine default), `always` (all verbatim lanes unconditionally as a prompt appendix; the diary-genre profile), `fused` (segments become scored, reranked, citable SearchHits inside the search pipeline instead of an appendix), `routed` (per-query dispatch: verbatim-shaped questions take the fused path, everything else stays shape_conditioned). |
| `RETRIEVAL_INSIGHT_EVIDENCE` | `off` | How derived insight rows (aspect aggregates + `summary_*` promotion/compaction summaries) reach answers: `off` (they ride the fact legs as ordinary rows), `routed` (fact legs exclude them; summarization/enumeration-routed questions retrieve them as their own dense+BM25 fused pool under a separate prompt slot — `INSIGHT_TOP_K`, not the fact budget). |
| `RETRIEVAL_DATE_ANCHORING` | `absolute` | How the generator's "today" anchors: `none` (session-date-convention golds, e.g. the LoCoMo eval profile), `session_date` (only when the caller sends `asOf`), `absolute` (asOf, else wall clock). |
| `RETRIEVAL_TEMPORAL_MODE` | `filter` | How an explicit `asOf` shapes retrieval: `filter` (strict bitemporal point-in-time closure), `overlap_boost` (the validity gate is relaxed; facts outside the interval survive with an exponential distance decay on their score — a slightly-wrong asOf degrades results instead of emptying them). |
| `RETRIEVAL_ENTITY_EXPANSION` | off | Second retrieval pass anchored on the top entities the first pass discovered and the query never named. Costs one extra embedding + two leg queries when it fires; enable per genre after measuring. |
| `RETRIEVAL_PROFILE_OVERRIDES` | — | JSON object mapping companyId → partial profile (`lanes` as an array of lane ids). Malformed per-tenant entries are ignored; the JSON shape is boot-validated. |

Introspection: `GET /v1/admin/retrieval-profile` (brain:admin) returns
the profile the calling tenant actually resolves to — use it to verify
an override took. The eval harness stamps the same object into every
report header.

Removed in the same refactor (delete from deployment env — they are
inert but lie): `SEARCH_RERANKER_ENABLED`, `SEARCH_HYPE_ENABLED`,
`SEARCH_QUERY_EXPANSION_N`. The LLM reranker is now a CAPABILITY: it
runs wherever an OpenAI key is configured, bounded by the stage budget
and `SEARCH_RERANK_SKIP_MARGIN`. After deploying this fold, expect the
`brain_search_rerank_total{outcome=invoked}` rate to rise; watch it and
OpenAI spend for a day, and tune the skip margin rather than looking
for the deleted kill switch.

## Retrieval feature flags

Infra-shaped knobs (budgets, windows, iteration counts) stay
individual env vars: flipping one is a service restart, not a schema
change.

| Flag | Default | What it does | When to enable |
|---|---|---|---|
| `SEARCH_CROSS_ENCODER_WINDOW` | `50` | Wide-window size that the cross-encoder reorders. Larger → more recall headroom, more Cohere tokens. | Long-tailed candidate distributions where the gold answer often sits beyond rank-20 from fusion alone. |
| `SEARCH_CROSS_ENCODER_LOCAL_WINDOW` | `20` | Window the LOCAL path reranks (it scores pairs sequentially, so it uses a tighter window than Cohere's `_WINDOW`). Bounded by the stage budget. | Rarely — raise only if local rerank latency is comfortably under `SEARCH_STAGE_BUDGET_CROSS_ENCODER_MS`. |
| `SEARCH_RERANKER_SC_N` | `1` | Permutation Self-Consistency: runs the reranker `N` times in parallel with shuffled orderings, aggregates via Borda count. `3` is the literature default. | Run-to-run jitter on the reranker. Costs N× LLM tokens (latency ~constant via the parallel limiter). |
| `SEARCH_RERANK_SKIP_MARGIN` | `0` | Relative-gap gate: skip the reranker when `(top1 − top2) / top1 ≥ M`. Cuts LLM cost on queries where the leader is already obvious. Tracked via `brain_search_rerank_total{outcome=skipped_margin}`. | After enabling the reranker, when `invoked` rate is high and recall has headroom. Start at `0.5` and tune via the metric. See operator playbook. |
| `SEARCH_PPR_ENABLED` | `0` | Personalized PageRank prior over the candidate-entity subgraph (HippoRAG-style). 3 power iterations, α=0.85. Multiplies rankScore by `(1 + 0.5·rNorm)`. | Fat tenants (≥ ~100 entities). Hub effects amplify pathologically on small graphs — measured. |
| `SEARCH_PPR_AUTO_THRESHOLD` | `0` | Auto-enables PPR when the candidate set ≥ N. Cheap proxy for tenant size — if the query already retrieved many candidates the graph is dense enough to support PPR. | Mixed-tenancy deployment (fat + lean tenants on the same service). Set `~50` and let it gate per-query. |
| `COMPACTION_HOT_RETENTION_DAYS` | `90` | Days kept in the searchable hot tier before compaction strips embedding + indexes. | Storage cost vs historical-search depth. |
| `COMPACTION_SUMMARIES` | `false` | Roll up compacted facts into one summary per `(entityId, predicate)` cluster. The summary keeps a fresh embedding and is searchable. | Long-history tenants where the warm tier needs to stay queryable. |

## Enabling the document pipeline + external indexers

The Source → Indexer → Candidates → Brain pipeline shipped complete but
**dark** — every route answers `503 feature_disabled` until you flip the
flags. Turn it on in stages, soaking each one:

**Prerequisites**

- Migrations current (`schema_migrations` through at least 0065).
- Job queue running in `enqueue` mode (`JOBS_QUEUE_MODE=enqueue`, the
  default) with a healthy worker (`brain_worker_is_leader == 1`) — async
  ingest, reindex backfills, and the nightly candidate sweeper are jobs.
- `OPENAI_API_KEY` with budget headroom: in-process indexer runs are
  per-chunk LLM extraction.

**Step 1 — `DOCUMENT_INGEST_ENABLED=1`.** Opens the REST surface with
the generalist (union) pass only. Soak: watch
`brain_indexer_runs_total{outcome}` (should be `succeeded`-dominated),
`brain_documents_total`, and ingest latency (`mode` unset runs
extraction inside the HTTP request — long documents block their caller;
prefer `mode:'async'` for anything beyond a page).

**Step 2 — `DOCUMENT_MULTI_INDEXER_ENABLED=1`.** Enables the relevance
router, dedicated per-pack runs, async fan-out, and external work-item
production. Soak: router fan-out warnings ("capped ... indexers"),
`MAX_DEDICATED_INDEXERS_PER_DOC` (default 8) as the LLM-cost backstop.

**Step 3 — connect an external indexer.** Install the pack
(`POST /v1/admin/packs`, `indexer.mode: 'external'`), mint an
`indexer:write` key (bind it to the pack via `packIds` — see api.md),
relay the `webhookSecret` from the install response if the pack declares
a `callbackUrl`, and point the integration at `GET /v1/indexer/work`
(protocol: [indexer-protocol.md](indexer-protocol.md), reference client:
`pnpm indexer:reference`). Soak: work items appear on ingest
(`external=true` runs), claims heartbeat within
`INDEXER_RUN_STALE_MINUTES`, unclaimed items expire per
`INDEXER_EXTERNAL_PENDING_TTL_DAYS`.

**Step 4 (only if consciously accepted) —
`DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL=1`.** Lets external indexers stage
candidates for `storeContent:false` documents. With no stored text
there is nothing to re-ground against: spans are unverifiable and
auto-commit into the graph flagged `ungrounded`. This is a trust
decision, not a tuning knob.

**PII note.** An `indexer:write` key can read the verbatim stored text
of documents routed to its pack(s) via `/v1/indexer/work/:id/content`
(post-redaction, but redaction is best-effort). Mint per-integration
keys, bind them to their packs, and treat external indexers as data
processors.

**Rollback.** Flip the flags off — the surface returns to 503 with no
data loss. Staged candidates expire per `CANDIDATE_PENDING_TTL_DAYS`;
stuck runs are reaped per the stale window; committed facts stay (they
are ordinary memory — retract/forget applies as usual).

## Enabling MCP pack tools

Pack-declared MCP tools ([mcp-pack-tools.md](mcp-pack-tools.md)) ship
dark behind `MCP_PACK_TOOLS_ENABLED` (default off). Two-stage rollout:

1. **`MCP_PACK_TOOLS_ENABLED=1`** — query tools only (the
   `MCP_PACK_QUERY_TOOLS_ENABLED=1` default). Query tools are served
   entirely in-process, fenced to each pack's own predicates, and run
   under the caller's scopes + ABAC row filter — the low-risk half.
   Re-install (or install) packs with `acceptMcpTools: true`; without
   stored consent nothing is served.
2. **`MCP_PACK_EXTERNAL_TOOLS_ENABLED=1`** — only after reviewing each
   consented pack's declared endpoints (the install refusal message
   lists them). External calls are HMAC-signed, SSRF-fenced, budget- and
   size-capped, and carry an opaque `installId` — never the tenant id.

> [!WARNING]
> `MCP_PACK_TOOLS_ALLOW_HTTP=1` disables the SSRF egress guard (plain
> http + loopback endpoints allowed). Dev/test only — never in
> production.

Rollback: flip the master flag off — pack tools vanish from
`tools/list` on the next binding-cache refresh (≤ `MCP_PACK_TOOLS_CACHE_TTL_MS`).

## Enabling marketplace billing (paid packs)

The registry marketplace (docs/domain-packs.md "Marketplace") ships dark:
with `DOMAIN_PACK_BILLING_ENABLED` unset/`0` every pack installs free and
pricing metadata is ignored — the correct self-hosted posture.

**Prerequisites**

- Migrations current (`schema_migrations` through at least 0067).
- Brain registered as a `Service` in the billing-service admin; the
  service API key it issues is what brain sends as `x-api-key`.

**Env**

```bash
DOMAIN_PACK_BILLING_ENABLED=1
BILLING_SERVICE_URL=https://billing.inite.ai   # valid http(s) — fails boot otherwise
BILLING_SERVICE_API_KEY=<service key>          # required while the flag is on
#BILLING_TIMEOUT_MS=5000                       # per-request budget
#BILLING_ENTITLEMENT_CACHE_TTL_MS=60000        # entitlement cache; never served stale
```

Fail-closed: when billing is unreachable and the entitlement cache is
cold, PAID installs answer 503 (free packs are unaffected — they never
touch billing). Curation keys: `registry:curate` / `registry:publish`
never ride user JWTs (absent from the JWT `VALID_SCOPES`); carry them on
an operator-issued credential — an auth-service `ik_…` key (resolved via
RFC 7662 introspection) in production, or a static `BRAIN_API_KEYS` env
entry in dev (the static table is disabled in production).

**Admin UI (brain-landing)**

The admin panels Packs / Marketplace / Sources talk to brain through the
landing's BFF proxy, which mints an M2M JWT with the scopes in
`BRAIN_SCOPE` (default `brain:read brain:write brain:admin
brain:read_pii`). That covers everything on the Packs and Sources pages
plus all Marketplace *reads*; Marketplace *writes* need more:

- feature / unfeature → `registry:curate`
- pricing, publisher profiles, yank / unyank → `registry:publish`

Missing scopes degrade gracefully — the Marketplace panel stays usable
read-only and shows an amber note naming the missing scope instead of a
generic error. The registry scopes never ride JWTs (absent from the JWT
`VALID_SCOPES` set in `src/auth/jwks.service.ts`), so the BFF's M2M
token can never carry them. To enable Marketplace writes from the admin
UI:

1. Issue an operator credential carrying
   `brain:admin registry:publish registry:curate`:
   - **production** — an auth-service API key (`ik_…`); brain resolves
     it via RFC 7662 introspection, which allows exactly these
     integration scopes;
   - **dev / self-hosted without auth-service** — a static
     `BRAIN_API_KEYS` env entry (the static table is disabled in
     production whenever a remote verifier is configured).
2. Set the plaintext key as `BRAIN_REGISTRY_API_KEY` in the
   brain-landing environment. The BFF proxy then sends it as the Bearer
   token on `v1/admin/registry/*` calls only; everything else stays on
   the JWT paths. Without the env var, marketplace writes keep the
   read-only degradation.

**Deliberately NOT in v1**

- No inbound billing webhooks — billing's outbound events are unsigned;
  entitlements are pull-only behind the TTL cache.
- No refund-driven uninstall: a refund revokes the entitlement (blocking
  REinstall), but packs already installed stay installed.
- No tax/VAT handling — amounts are passed to billing verbatim.
- Direct manifest install (`POST /v1/admin/packs` with a manifest body)
  is not fenced — the paywall guards the REGISTRY resolve path only; an
  operator who already has the manifest file can always install it.

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
| `pnpm test:e2e:jobs` | Real-Surreal e2e: enqueue → claim → renew → complete cycle, dedup collision, fail+requeue, zombie reap, leader_lease in `system` DB. | After touching anything in `src/jobs/` or migrations 0028-0031. |
| `pnpm lint` | ESLint flat config. | Every commit. |

## See also

- [Operator playbook](operator-playbook.md) — day-2 troubleshooting runbooks.
- [Deploy runbook](DEPLOY.md) — the production deployment + observability stack.
- [API reference](api.md) — the endpoint families these flags gate.
- [Document pipeline](document-pipeline.md) — the architecture behind the pipeline flags.
