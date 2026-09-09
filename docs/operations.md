# Operations

Every env var and feature flag, queue tuning, the api/worker role
split, staged enablement runbooks, boot validation, and test commands —
the operator's reference for running Brain.

**Contents:**
[Required env vars](#required-env-vars) ·
[Optional env vars](#optional-env-vars) ·
[Brain v2 flag families](#brain-v2-flag-families) ·
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
| `FORGET_MAX_TX_RECORDS` | `10000` | Max records a single entity-forget erase may touch in ONE atomic transaction (facts + edges + episodes + segments + audit-mirror rows). The GDPR erase is all-or-nothing (one `BEGIN`/`COMMIT`); an entity whose fan-out exceeds this is refused with `413` **before any mutation** rather than building an oversized transaction that risks the server write-key limit — use whole-tenant offboarding (drop database) for that case, or raise the cap deliberately. |
| `OPENAI_CHAT_MODEL` | `gpt-4o-mini` | Used by `ingest-mention` extraction. |
| `CONFLICT_*` | per spec | Override the resolution weights at runtime; defaults match `core/capabilities/knowledge.yaml`. |
| `MULTI_HOP_PLANNER_MODEL` | `OPENAI_CHAT_MODEL` | Override the chat model for the multi-hop planner LLM call. |
| `MULTI_HOP_PLANNER_CONCURRENCY` | `4` | Max in-flight planner calls. |
| `AUTH_SERVICE_JWKS_URL` | unset | Enables JWKS-based verification of user JWTs (unset = static keys only, dev). In prod the JWKS document lives at `https://auth.inite.ai/.well-known/jwks.json`. |
| `AUTH_SERVICE_ISSUER` | unset | Expected `iss` claim for JWKS-verified JWTs; production refuses to boot with JWKS on and this unset. MUST equal the auth-service's REAL issuer — `https://auth-api.inite.ai` in prod, NOT the `auth.inite.ai` host the JWKS document is fetched from. A mismatch rejects EVERY JWT as "Invalid credentials"; grep the boot log for `[JwksService]` `issuer=` to confirm the running value. |
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
| `EMBEDDER_PROVIDER` | `openai` | `openai` (text-embedding-3-small, 1536d) or `bge-m3` (local, 1024d multilingual, ~150MB ONNX). Production ships `bge-m3` via the deploy workflow. Switching providers requires reindex (`POST /v1/admin/maintenance/reindex`) — old vectors don't match new queries. **Warmup window:** with `bge-m3` the ONNX model takes ~10-20s to load. During that window `/ready` is 503 (it tracks the PRIMARY provider only), embedding requests for reads and writes are refused with 503 instead of sending incompatible vectors to the database. Hybrid `/v1/search` keeps answering lexical-only and marks the response `degraded: ["vector_leg"]` (metric `brain_search_vector_leg_degraded_total`); vector-only searches fail. A failed warmup is **retried** (5s, doubling, capped at 5 min) and re-armed by every `/ready` poll and embed attempt, so a transient model-download failure or a dead inference worker heals without a restart; `warmupStatus()` (failures, last error, next retry) is what the health surfaces read. The read guard is default-on (`EMBEDDING_SPACE_STRICT`; explicit `0`/`false` restores unsafe legacy read fallback); vector writes are always guarded. The write refusal is deliberate and unconditional: vector columns are `option<array<float>>` with no width, so a fallback-width vector persists silently and permanently, after which `vector::similarity::cosine` errors for **every** row of that table and the HNSW index can no longer be built (verified on SurrealDB 3.2.4). Do not start the reindex until `/ready` is 200. |
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
| `SEARCH_HNSW_ENABLED` | `0` | Approximate-KNN vector leg over the per-tenant HNSW indexes (create first: `POST /v1/admin/maintenance/hnsw`, per tenant, after any embedder reindex). Tenants without indexes soft-fall back to the exact full scan, so the flag is safe to flip globally mid-rollout. `SEARCH_HNSW_OVERFETCH` (4) × k candidates are pulled before WHERE filters (KNN filters post-hoc); `SEARCH_HNSW_EF` (100) is the search width. Re-run the quality eval after enabling — approximate recall is a trade. Worth it past ~50k active facts per tenant. Every build is `CONCURRENTLY` (the synchronous DDL was a measured failure: 20 000 × 1024-d aborts after ~133 s with a RocksDB transaction conflict, while `CONCURRENTLY` reaches `ready` in 4.2 s), so a build is asynchronous: `{action:'create'}` holds the request for `waitMs` (body field, default `60000`, `0` = answer with the first probe, max `600000`) and then answers with the per-index build state it reached; `{action:'status'}` re-reads it. **Check `ready` before flipping this for a tenant**: an index that exists but is still `indexing` answers the KNN operator with the same unranked, null-distance rows a missing index does. |
| `HNSW_PROVISION_ENABLED` | _follows `SEARCH_HNSW_ENABLED`_ | Unset, provisioning is on exactly when the KNN leg is on; set it explicitly only to build ahead of flipping the search flag (`1`) or to hold provisioning back while the search flag is on (`0`). It closes the process hole behind #506: production sets the KNN leg on globally while index creation was a manual per-tenant admin call with exactly one caller in the codebase and nothing recording which tenants had indexes — so every tenant onboarded since the last manual sweep was served k arbitrary rows with a null distance rather than an error. On, three things exist: (1) a hook on `SurrealService.ensureSchema()` — the one place a tenant database is created, since there is no onboarding route — notes each new tenant and provisions it off the request path; (2) a leader-elected nightly sweep at **05:10 UTC** reconciles the whole roster; (3) every observation is recorded in `tenant_registry` (`indexState` / `indexDetail` / `indexStateAt` / `embeddingSpace`, migrations 0104 + 0133), so `GET /v1/admin/maintenance/hnsw/roster` answers "which tenants have a ready index" with no DDL and no per-tenant round trip. Provisioning uses the idempotent `ensure` action — defines only **absent** indexes, always `CONCURRENTLY`, never `REMOVE`s, never restarts a build in flight, never waits — so it is safe on every pass and cannot drop a working index. Measured on SurrealDB 3.2.4 over 20 000 × 1024-d: a probe-only pass is ~0.2 ms of engine time per index; the `DEFINE … CONCURRENTLY` returns in 2.4 ms and the build reaches `ready` in under 4 s. |
| `HNSW_PROVISION_MAX_BUILDS_PER_RUN` | `5` | How many tenants may START index builds in one reconciliation run. Bounds the blast radius of the FIRST run after enablement — the only one that finds a backlog. Tenants held back by the cap are still probed and recorded, so the roster tells the truth about them the same night; only the DDL waits. `HNSW_PROVISION_TIME_BUDGET_MS` (`600000`) bounds the walk (keep it under the 20-minute lease TTL); a 250 ms pause after each tenant that actually emitted DDL keeps five builds from landing in the same millisecond. |
| `INGEST_INLINE_RESOLUTION_HNSW` | `0` | Route the inline entity-resolution name-candidate scan through the same per-tenant HNSW index instead of a full cosine scan of every `name` fact on each inline resolution. Over-fetches `INGEST_INLINE_RESOLUTION_HNSW_OVERFETCH` (8) × k candidates before the name/type WHERE (KNN filters post-hoc); `INGEST_INLINE_RESOLUTION_HNSW_EF` (100) is the search width. Tenants without the index soft-fall back to the full scan. Only active when `INGEST_INLINE_RESOLUTION_ENABLED` is also on. **Correctness gate:** a missed approximate candidate creates a DUPLICATE entity (not just lower recall like search) — before enabling per tenant, run the dedup/quality eval and confirm the HNSW path finds every candidate the full scan does. Higher default over-fetch than search (8 vs 4) because `name` facts are a small fraction of all facts; a name-query embedding is near other name facts, but verify per corpus. |
| `RETRIEVAL_COVERAGE_SCAN_MODE` | `brute` | Dense-leg mode of the two coverage-first scan lanes — mention-scan over `episode_segment` (`RETRIEVAL_TIMELINE_EVIDENCE=scan`) and query_arc over `knowledge_fact` (`RETRIEVAL_INSIGHT_EVIDENCE=query_arc`). `brute` = exact full-table cosine (correct at eval scale by design). `hnsw` = approximate KNN against the per-tenant indexes (`segment_embedding_hnsw` / `fact_embedding_hnsw`; `create` builds all four indexes) with `RETRIEVAL_SCAN_HNSW_OVERFETCH` (4; query_arc doubles it internally) × k candidates pulled before the WHERE gates and `RETRIEVAL_SCAN_HNSW_EF` clamped up to the overfetched k. Falls back to the brute scan on error OR an empty post-filter pool. **Enable gate per tenant:** build indexes, then `npx tsx scripts/scan-hnsw-parity.ts --tenant <id>` must show recall ≥ 0.98 before flipping the tenant's override. Segment-index embedder-swap caveat: reindex-embeddings does NOT rewrite segments — drop → re-segment → create. |
| `RETRIEVAL_COVERAGE_LEX_MODE` | `phrase` | Lexical-leg (BM25) query shape of the same two scan lanes. `phrase` = one matcher per indexed field fed the whole extracted topic phrase — the matches operator (`@N@`) is AND-semantics over analyzed tokens on SurrealDB 3.x, so a multi-word topic must appear IN FULL and the lexical leg rarely fires (V11 audit A2). `or_terms` = per-term matchers over the stripped topic terms OR-ed with unique match refs (bounded at 8 terms), scored as the sum over terms of the best per-field BM25 — a row mentioning ANY topic word is a lexical hit, and rows covering more topic words rank higher. Overlayable per tenant (`coverageLexMode`). Measured-behavior change: flip after an eval pair, not by default. |
| `SYNTHESIZE_MIN_FACT_TRUST` | `0` | Citation floor on write-time source reputation (beside `SYNTHESIZE_MIN_CONFIDENCE`). `0` = off; floors ≤ 0.5 never drop unscored facts. |
| `DOCUMENT_INGEST_ENABLED` | `0` | Master switch for the [document pipeline](document-pipeline.md) (`POST /v1/ingest/document` + `/v1/documents/*`). Off = every route answers 503 and the legacy mention/fact paths behave byte-identically. |
| `DOCUMENT_MULTI_INDEXER_ENABLED` | `0` | Dedicated per-pack indexer runs + relevance router + async (queue-driven) document ingest. Off = only the `'_general'` union pass runs. |
| `REINDEX_ON_PACK_INSTALL` | `0` | Enqueue a pack-scoped backfill over stored documents at the end of every pack install/upgrade. |
| `INGEST_MENTION_VIA_DOCUMENT` | `0` | Route `POST /v1/ingest/mention` through the document pipeline (response contract preserved; user-scoped mentions keep their `userId` on the document, committed facts and projected scenes — 0127). Off = legacy mention path, untouched. |
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
| `SOURCE_META_STRICT` | `0` | Document `meta` / direct-fact `metadata` is sanitized (snake_case keys, short scalars, ≤16) before landing as ABAC-matchable `source.meta` on facts. Off = drop-and-warn; on = the ingest answers 400 `invalid_meta` — a silently-dropped `data_class` would silently widen access. Scope: **caller-supplied meta only**. Brain's own document-header provenance (the mention wrapper's `contextRef` identifiers, the 0111 tool-observation hop) rides a separate internal channel (`src/documents/document-meta.ts`), is never projected onto `source.meta`, and is not forgeable by a caller — those keys are stripped from a caller's bag. |
| `ABAC_DB_FENCE_ENABLED` | `0` | Binds the request's pushdown-safe deny rules to `$caller_policy_deny` on scoped connections for the 0057 field-PERMISSIONS fence. **Currently inert**: SurrealDB skips PERMISSIONS for the `brain_caller` system user (same applies to the 0005 PII fence) — see the finding in [`docs/abac.md`](abac.md#db-level-fence-status-migration-0057) and the canary in `test/abac-db-fence.e2e-spec.ts`. Keep off until callers move to record users. |
| `POLICY_META_UNION_ENABLED` | `0` | Effective-meta union: corroborated facts also inherit their confirming documents' meta for DENY evaluation (most-restrictive union, Zep's episode-union equivalent). One batched `contentHash` lookup per request behind a 10k/5min process LRU; applies on search fusion + `graph_retrieve` (supplementary legs evaluate own-meta only). Facts committed before the projection: run `POST /v1/admin/policy-sets/backfill-meta` until `remaining=0`. |
| `DOMAIN_PACK_TRUSTED_KEYS` | unset | Pack-install trust store: JSON object mapping `publisher` → ed25519 PEM public key. Malformed JSON fails boot (env validation) — a typo would silently empty the store and every signed pack would fail as "unknown publisher". |
| `DOMAIN_PACK_REQUIRE_SIGNATURE` | `0` | When `1`/`true`, `POST /v1/admin/packs` rejects unsigned manifests. Values outside `1/0/true/false` fail boot — an unrecognized value would silently disable enforcement. |
| `PACK_REGISTRY_REQUIRE_SIGNATURE` | `0` | Same policy for `POST /v1/admin/registry/packs` (publish into the global catalogue). Same strict value set. |
| `PACK_SEED_INGEST_ENABLED` | `1` | Ingest a pack's `seedDocuments` through the document pipeline on install (`pack_seed_ingest` job). Requires `DOCUMENT_INGEST_ENABLED`; when either is off the install response reports a skip — install never fails because of seeds. |
| `PACK_MEMORY_PROJECTIONS_ENABLED` | `0` | Pack memory projections (migration 0110) — **two producers, one shadow world**. **Document origin:** external candidate submissions (`POST /v1/documents/:id/candidates`) may carry `scenes`/`stateDeltas` arrays — validated against the submitting pack's own `memoryModel` declarations (`sceneSchemas`/`stateModels`) — staged as candidate kinds `scene`/`state_delta` and projected at commit time. **Capture origin:** each `POST /v1/ingest/mention` turn is matched against the *installed* packs' declared `sceneSchemas.cues` (literal substrings — model-free: no LLM, no embedding, no extra read) and `stateModels.states`, and projected inline; the row carries a `memory_episode_member` edge to its L0 turn, which is both its erasure anchor (the existing forget cascades take it) and the reason the capture producer needs `EPISODE_SUBSTRATE_ENABLED` — an uncaptured turn is skipped. Capture rows are idempotent per (turn, pack, `schemaId`), so replays converge instead of duplicating. Both origins write **shadow** `memory_episode` rows under `segmenterVersion` `pack:<packId>+<fp>` (projection-ledger name `scenes:<packId>`; purge a world via `DELETE /v1/admin/maintenance/scenes/versions/:v`). Off = submissions carrying either array are rejected 400, the capture producer returns before any read, nothing is staged or projected — byte-identical. Scene/state_delta payloads in the candidates audit view are default-deny: content opens only under `brain:read_pii`. The GDPR forget cascades for projected rows run regardless of this flag. |
| `INDEXER_WEBHOOK_PUSH_ENABLED` | `1` | Signed `work_available` webhook hints to external packs declaring `indexer.external.callbackUrl`. Best-effort (retries + per-URL circuit breaker; `INDEXER_WEBHOOK_RETRY_BASE_MS` tunes backoff); polling stays the source of truth. |
| `REGISTRY_UPSTREAM_URL` | unset | Pull-only registry mirroring: pull the upstream catalogue and republish missing versions locally through the normal publish path. Unset = off, no job registered. Optional `REGISTRY_UPSTREAM_TOKEN` (a `brain:read` key on the upstream); cadence via `REGISTRY_MIRROR_INTERVAL_HOURS` (default 24). |
| `MCP_PACK_TOOLS_ENABLED` | `0` | Master switch for [pack-declared MCP tools](mcp-pack-tools.md). Off = the MCP surface is exactly the static tool families. Sub-flags: `MCP_PACK_QUERY_TOOLS_ENABLED` (default `1`), `MCP_PACK_EXTERNAL_TOOLS_ENABLED` (default `0`), `MCP_PACK_TOOLS_ALLOW_HTTP` (dev/test ONLY — disables the SSRF egress guard), `MCP_PACK_TOOLS_CACHE_TTL_MS` (default 30000). |
| `DOMAIN_PACK_BILLING_ENABLED` | `0` | Paid packs via the central billing service — see [Enabling marketplace billing](#enabling-marketplace-billing-paid-packs). Off (the self-hosted posture) = pricing metadata is ignored, every pack installs free. Requires `BILLING_SERVICE_URL` + `BILLING_SERVICE_API_KEY` when on (boot-validated); `BILLING_TIMEOUT_MS` / `BILLING_ENTITLEMENT_CACHE_TTL_MS` tune the client. |
| `OTEL_ENABLED` | `0` | Enable OpenTelemetry tracing. When `1`, exports OTLP/HTTP traces with auto-instrumentation for `http` (so OpenAI + JWKS calls show up) + `express` (Nest). The pipeline emits explicit child spans under `search`: `vector_leg`, `lexical_leg`, `route`, `ppr`, `fetch_neighbours`, `rerank` — each annotated with candidate counts. Plus Phase K3 queue handoff spans: `jobs.enqueue` (PRODUCER) + `jobs.process <jobType>` (CONSUMER, linked via traceparent on the row). Bring-your-own backend via `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL, no path — the exporter appends `/v1/traces`; prod points it at the monitoring stack's Alloy, see `monitoring/README.md`). Service name defaults to `inite-brain-service`; override via `OTEL_SERVICE_NAME`. No-op when off — zero cost. |

Prod observability (metrics scrape, log shipping, trace storage,
Grafana dashboards + alert rules) is the `monitoring/` compose stack on
the droplet — entry point [`monitoring/README.md`](../monitoring/README.md),
Grafana at `https://brain.inite.ai/grafana`.

## Brain v2 flag families

The Brain v2 waves (evidence plane, scenes/beliefs, fovea optics,
outcome/decision telemetry, tool observations, privacy fences) shipped
default-off behind these families. `GET /v1/admin/config` is the live
catalogue (effective values + defaults); this section is the operator
overview — one line per flag, plus the orderings that matter.

### `EVIDENCE_*` — evidence plane + claim grounding (Brain v2.1)

| Flag | Default | Purpose |
|---|---|---|
| `EVIDENCE_SUBSTRATE_ENABLED` | `0` | Master switch for the multimodal evidence substrate writers (evidence_asset / evidence_fragment / derived_representation, 0109); off = every write 503s. GDPR cascade + retention run regardless. |
| `EVIDENCE_FS_ROOT` | unset | Directory root for the `fs://` storage adapter; unset = the adapter throws a clear unconfigured error. |
| `EVIDENCE_MAX_BYTES` | 1 GiB | Sanity cap on a registered asset's DECLARED byteLength, and the transfer bound of the blob upload surface — applied there as `min(this, 64 MiB)`, so raising it past that memory-storage ceiling raises nothing. |
| `EVIDENCE_BLOB_UPLOAD_ENABLED` | `0` | The byte surface: `POST /v1/ingest/evidence-blob` (multipart) — bytes into the content-addressed storage adapter, server-computed `byteHash`/`byteLength`/`storageRef`, asset registered `hot` and SCANNED before it is dispatchable. Media types are a conservative allowlist checked against the declared modality (no SVG/HTML/archives/octet-stream). Off = a bare 404 raised BEFORE the body is parsed. Requires `EVIDENCE_FS_ROOT`, the substrate flag, and `EVIDENCE_QUARANTINE` (uploaded bytes are external ingest — see the quarantine order below). |
| `EVIDENCE_PROCESSOR_BROKER` | `0` | Trusted platform-owned processor adapters over registered assets, each run an idempotent `processing_run` row (0121). Requires the substrate flag. |
| `EVIDENCE_QUARANTINE` | `0` | External-ingest quarantine seam (0121): assets get `quarantineStatus` (`clean` internal / `quarantined` external_ingest); the broker refuses non-clean assets. **Off = `origin:'external_ingest'` is rejected 503 outright (fail closed)** — enable BEFORE accepting any externally-sourced media. |
| `EVIDENCE_DERIVED_MAX_BYTES` | 1 MiB | Cap on what an adapter may read from a blob and on any single derived output (reject, never truncate). |
| `EVIDENCE_GROUNDING_STAMP` | `0` | Write-side: stamp `knowledge_fact.groundingStatus` (`grounded`/`ungrounded`) from the presence of observational source (episode ids / `evidence[]` / conversationId). Absent field = legacy row, never backfilled. |
| `EVIDENCE_FAIL_CLOSED_CAPTURE` | `0` | ingestMention REQUIRES the L0 episode write to succeed and stamps the episode id into every extracted fact — no extraction without a stored observation. Requires `EPISODE_SUBSTRATE_ENABLED`. |
| `EVIDENCE_UNGROUNDED_EXCLUDE` | `0` | Consolidation gate: the promotion runner excludes `ungrounded` members from summary groups (legacy rows still promote). |
| `EVIDENCE_UNGROUNDED_SERVING_GATE` | `0` | Strict serving: a supported answer whose EVERY citation is `ungrounded` abstains with reason `ungrounded_evidence`; mixed/legacy support serves. |
| `EVIDENCE_FRAGMENT_CITATIONS` | `0` | Fragment-arm evidence citations: rendered media evidence carries `[evidence_fragment:...]` headers, the generator may cite fragments (rendered-set fenced), citations carry assetId + capability — how `FOVEA_EVIDENCE_CAPABILITY` passes for non-text. |
| `EVIDENCE_RAW_READ_ENABLED` | `0` | The raw-read gateway (`/v1/evidence/*` — see [api.md](api.md#evidence-raw-read-gateway)); off = bare 404s. |
| `EVIDENCE_SIGNED_URL_SECRET` | unset | HMAC secret for signed raw URLs; boot hard-errors when shorter than 32 chars while the gateway is on. No default on purpose. |
| `EVIDENCE_SIGNED_URL_TTL_SECONDS` | `300` | Signed-URL lifetime — deliberately short; expiry + the live-grant re-check at redeem are the only revocation levers. |
| `EVIDENCE_GRANTS_API_ENABLED` | `0` | The sharing surface (`/v1/evidence/*/grants` — see [api.md](api.md#evidence-sharing-surface)): grant, list and revoke the ownership rows (0122) the read side spends. Requires the substrate flag (boot warns on the pair); off = bare 404s raised in a guard, so not even a malformed body reveals the route. |
| `EVIDENCE_ORPHAN_BLOB_GC` | `0` | Orphan-blob GC, stage one: `POST /v1/admin/maintenance/evidence/orphan-blob-gc` exists and REPORTS blobs no `evidence_asset` row references (plus interrupted-write debris), deleting nothing. Off = a bare 404, no store walk, no query. Deliberately NOT gated on `EVIDENCE_SUBSTRATE_ENABLED` — a delete-side pass must stay usable after the writers are turned off. |
| `EVIDENCE_ORPHAN_BLOB_GC_DELETE` | `0` | Stage two: actually unlink what stage one reports. Off = every run is a dry run, whatever the caller asks for. **Read a dry run before enabling this** — a wrong orphan sweep is unrecoverable. |
| `EVIDENCE_ORPHAN_BLOB_GC_SCHEDULED` | `0` | Run the sweep nightly at 04:35 UTC over the tenant roster (lease-guarded). The admin route works without it; this is the separate decision to let the pass run itself. |
| `EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS` | `24` | A blob younger than this is never a candidate — the upload path stores bytes before their row exists, and a sweep that raced it would delete a live upload. Generous on purpose: waiting costs disk, being wrong costs evidence. |
| `EVIDENCE_ORPHAN_BLOB_GC_MAX_DELETIONS` | `500` | Per-tenant deletions in ONE run — the blast radius of a wrong answer. A capped run still REPORTS the whole backlog. |
| `EVIDENCE_ORPHAN_BLOB_GC_TIME_BUDGET_MS` | `600000` | Wall-clock budget for one run; the roster stops starting new tenants once spent. Nothing is lost — an orphan is rediscovered by enumeration next run. |

**Grounding order:** stamp before you gate. Enable
`EVIDENCE_GROUNDING_STAMP` first and let writes accrue stamps; only
then consider `EVIDENCE_UNGROUNDED_EXCLUDE` / `_SERVING_GATE` (both
treat legacy unstamped rows leniently, but a gate enabled on a corpus
with zero stamps protects nothing). **Quarantine order:** enable
`EVIDENCE_QUARANTINE` before any external media ingest — while it is
off, external-origin registration is refused entirely. That is also why
`EVIDENCE_BLOB_UPLOAD_ENABLED` needs it: bytes arriving over HTTP are
external ingest by definition, so with the seam off every upload answers
503 (boot warns on the pair). Note the scan hook shipped today is the
ALLOW-ALL stub — it exercises the quarantined → scanning → clean
lifecycle but passes everything; install a real scanner before trusting
uploads from untrusted callers. **Sharing order:** the sharing surface
hands out the very grants the raw-read gateway spends, so turn
`EVIDENCE_GRANTS_API_ENABLED` on only once you are satisfied with who
holds `brain:write` — a caller who can already read an asset can hand it
to anyone, and revoking the LAST grant kills the asset for everyone
(minted signed URLs included, by design).

**Orphan-GC order: look, then delete.** The sweep is staged because its
failure mode is destroyed evidence, not a bad answer. Turn on
`EVIDENCE_ORPHAN_BLOB_GC` alone, run the route with the tenant you care
about, and read `orphans` / `bytesReclaimable` / `sampleOrphans` in the
response (the same numbers reach `brain_evidence_orphan_blobs_total`, so
`orphan` with a flat `deleted` is the "still looking" state). Only when
the sample is bytes you recognise as leaked should
`EVIDENCE_ORPHAN_BLOB_GC_DELETE` go on. A run can always be forced back
to report-only per call (`{"dryRun": true}`) or tightened
(`{"maxDeletions": 10}`) — the body can only make a run MORE
conservative; whether a byte may be destroyed at all is the flag's
decision. Note what the sweep will NOT collect, by design: a blob any row
still points at (any tenant, any row state — a quarantined row, a `gone`
tombstone whose blob delete failed), a blob younger than the grace
window, and a ref the 0114 hard-erasure outbox has already claimed (that
drainer owns it). What it DOES collect beyond orphaned blobs is
interrupted-write debris — the `.tmp-…` files a process killed between
write and rename leaves behind, which no ref can address.

### `TOOL_OBSERVATION*` — MCP tool-call observations (0111)

| Flag | Default | Purpose |
|---|---|---|
| `TOOL_OBSERVATIONS_ENABLED` | `0` | Per-request MCP builds apply the content-free observation wrapper (tool, digests, ok, durationMs); ingest accepts `toolObservationRef`; nightly prune runs. Denied calls record nothing. |
| `TOOL_OBSERVATION_CONTENT` | `0` | Opt-in for the ONE content-bearing column (`contentExcerpt`, sanitized, ≤512 chars) on top of the master flag. Off = digest-only rows (the content-free contract). |
| `TOOL_OBSERVATION_RETENTION_DAYS` | `30` | Days raw observation rows are kept (03:41 UTC prune). |

### `SCENES_*` — scene substrate + belief promotion (Brain v2)

Construction is shadow: these flags build the episodic/belief substrate
without touching serving. Serving FROM `semantic_belief` is its own
opt-in lane — see [`BELIEFS_*`](#beliefs_--belief-serving-lane-0126)
below (the beliefs READ API is also its own flag,
`BELIEFS_API_ENABLED`).

| Flag | Default | Purpose |
|---|---|---|
| `SCENES_SEGMENTATION_ENABLED` | `0` | Master: scene composer + `POST /v1/admin/maintenance/scenes` (0106). |
| `SCENES_TOPIC_BOUNDARY` | `0` | Within-session topic split (one embedding batch per conversation — the surface's only paid step; no LLM anywhere). |
| `SCENES_TOPIC_MIN_COSINE` | `0.55` | Cosine floor for the topic split. |
| `SCENES_MAX_TURNS` | `40` | Force a scene boundary at this many turns. |
| `SCENES_LLM_ENRICHMENT` | `0` | ONE structured LLM call per scene (gist, memoryValue vector, stateDeltas); idempotent per enrichment-version composite. |
| `SCENES_FACT_BACKLINK` | `0` | Stamp facts with `source.memoryEpisodeIds` (idempotent) — facts become pointers into the episodic plane. |
| `SCENES_VERSION_FINGERPRINT` | `0` | Fingerprint the segmenter config into the version so a config change forks a NEW coexisting scene world instead of overwriting in place. |
| `SCENES_BELIEF_PROMOTION` | `0` | Belief promotion (Belief-A, 0120): fold ENRICHED scenes into `semantic_belief` supersede-chain revisions via `…/scenes/beliefs`. |
| `SCENES_BELIEF_MIN_SCENES` | `0` | Corroboration floor: promote a (subject, field) only when the winning value spans at least this many DISTINCT conversations (0 = off). |
| `SCENES_VALUE_GATE_ENABLED` | `0` | Memory-value promotion gate — the first consumer of the 0106 value vector beyond `explicitness`. A scene promotes UNLESS `novelty` AND `contradiction` AND `stateChange` are all PRESENT and all below `SCENES_VALUE_GATE_MIN`. "Promote unless demonstrably noise", never "promote only if demonstrably valuable": an UNDEFINED dimension is an unknown, not a confident zero, so an unscored world (pack scenes, legacy rows, enrichment off) promotes exactly as with the gate off — and a scene with HIGH contradiction always promotes, since it is the one that changes the world model. Refusals land in `skippedLowValue` (run summary + API response) and one log line per scene. |
| `SCENES_VALUE_GATE_MIN` | `0.05` | Noise floor for the gate, in `[0,1]`. `0` makes the gate a no-op — turn the flag on at `0` first and watch `skippedLowValue` before choosing a floor. Ignored unless the gate is on. |
| `SCENES_BELIEF_LLM_SYNTHESIS` | `0` | ONE LLM call per belief create/revise to phrase the statement; any failure degrades to the deterministic template. |
| `SCENES_BELIEF_NEGATION_DELTAS` | `0` | Fold state REMOVALS (sold / quit / ended): a stateDelta with empty `to` + non-empty `from` becomes a belief contribution with the sentinel value `none` (`priorValue` = the removed state). Both-ends-empty deltas stay dropped. |
| `SCENES_BELIEF_FIELD_FOLD` | `0` | Deterministic field-name folding: an enricher-re-coined field name folds onto an existing `(userId, subject)` field when its extra tokens are all generic modifiers; the EXISTING name wins; more than one match folds nothing and warns loudly. No embeddings, no LLM. |
| `SCENES_PACK_DELTA_PROMOTION` | `0` | Also promote the PACK-PROJECTION scene worlds (`pack:<packId>+<fp>`, written by BOTH 0110 projectors — the document scene-candidate writer and the capture-path mention producer — under `PACK_MEMORY_PROJECTIONS_ENABLED`). Their deltas carry `field` = `<packId>__<stateModel.field ?? stateModelId>`, so a document ingested — or a turn captured — for a tenant with an installed pack finally reaches the belief plane; the pack namespace keeps two packs that share a local attribute name in SEPARATE belief groups. Pack scenes have no `enrichmentVersion` (their deltas come from the pack's own reading, not the enricher), so that requirement is dropped for `pack:` worlds only. The `#387` single-user fence is unchanged — a TENANT-GLOBAL document's scenes carry no `userIds` and promote for no one. |

Order: master flag → compose → (`SCENES_LLM_ENRICHMENT` → enrich) →
(`SCENES_BELIEF_PROMOTION` → beliefs). Enrichment is a prerequisite for
promotion — the belief fold reads enriched fields only.

Exception: `SCENES_PACK_DELTA_PROMOTION` admits pack-projected scenes
WITHOUT enrichment (the pack indexer already read them). Two operator
notes for that lane: the pack world must exist first
(`PACK_MEMORY_PROJECTIONS_ENABLED` + an installed pack whose manifest
declares `memoryModel.stateModels`), and `SCENES_BELIEF_MIN_SCENES` is a
distinct-CONVERSATION floor — DOCUMENT scenes carry no conversation, so
any non-zero floor excludes document-projected beliefs entirely (a
capture-origin scene carries its turn's conversation and is unaffected).

### `BELIEFS_*` — belief serving lane (0126)

The first serving path over `semantic_belief`: an extra evidence lane in
`/v1/synthesize` alongside the fact lanes.

| Flag | Default | Purpose |
|---|---|---|
| `BELIEFS_SERVING_LANE` | `0` | Serve beliefs in synthesize: BM25 over `semantic_belief.statement` (0126), top-3, rendered into the evidence set; the generator may cite them via `citedBeliefIds`, which resolve through the rendered-set fence into belief-arm `evidenceCitations` (`beliefId` + rendered excerpt). Fail-closed single-user scope: no `userId` → no query, `active` + visibility re-check per belief. |
| `BELIEFS_LANE_DATE_DISAMBIGUATION` | `0` | Render belief lines as `belief current since <day>` instead of `as of <day>` — a belief line's date is the belief REVISION's `validFrom`, not the event date. ONE render site, so generator, verifier, and fragment-zoom re-verify read identical lines. No-op without the serving lane. |
| `BELIEFS_FACT_DAMPING` | `0` | Suffix (`(superseded by current belief: <field> = <value>)`) and stably demote fact lines that a lane-matched CURRENT belief contradicts — same (subject, field) key as the fact's (canonicalName, predicate) after trim/case normalization, different value; equal values and belief lines untouched. ONE computation feeds generator, verifier, and fragment-zoom re-verify; outcomes on `brain_belief_damping_total`. No-op without the serving lane's matched beliefs (boot validation warns on the inconsistent pair). |

### `FOVEA_*` — focus calibration + serving integrity

| Flag | Default | Purpose |
|---|---|---|
| `FOVEA_FOCUS_CAPTURE` | `0` | Capture the per-query focus signal at the synthesize verdict point + the admin fit/measure surface. Serving-neutral — the prerequisite for every adaptive flag below. |
| `FOVEA_ADAPTIVE_L3` (+`_THRESHOLD`, `0.5`) | `0` | L3 escalation trigger + session count adapt to the calibrated focus confidence (needs a fitted per-class model; without one, byte-identical to static). |
| `FOVEA_ADAPTIVE_ABSTAIN` (+`_THRESHOLD`, `0.5`) | `0` | Pre-generation coverage abstention adapts to the calibrated PRE-ANSWER confidence (only where `RETRIEVAL_ABSTENTION_CALIBRATION=coverage`). |
| `FOVEA_LENS_SUPPRESS` (+`_MIN_COSINE`, `0.5`) | `0` | Subtractive per-class lane suppression before retrieval (never adds, never reorders; needs a fitted model). |
| `FOVEA_PLAUSIBILITY_CHECK` | `0` | ONE extra LLM judge over CITED premises after a supported verdict; implausible → abstain. Adds one paid call per supported answer. |
| `FOVEA_REQUIRE_CITATIONS` | `0` | A supported answer with ZERO citations becomes low_coverage/abstain. Live-behavior change — validate before enabling. |
| `FOVEA_L3_EPISODE_CITATIONS` | `0` | L3 transcript renders per-turn `[episode:...]` headers; transcript-grounded claims come back as span-verified `evidenceCitations`. |
| `FOVEA_EVIDENCE_CAPABILITY` | `0` | Verdict gate (0113): a supported answer citing a predicate that REQUIRES non-text evidence abstains with `evidence_capability_unmet` unless matching-capability evidence is cited. |
| `FOVEA_ATTENTION_HINTS` | `0` | Pack attention hints as an ordering-only L3 anchor boost. |

### `PRIVACY_*` — user-scope security fences (0117)

| Flag | Default | Purpose |
|---|---|---|
| `PRIVACY_SEGMENT_USER_FENCE` | `0` (code) | Per-member fence for verbatim windows: a user-scoped caller is admitted to a mixed-user (`userId=NONE`) window only when its persisted `userIds` set is empty or CONTAINS the caller. **Fail-closed on pre-0117 rows (`userIds IS NONE`).** |
| `PRIVACY_COMPOSER_USER_SCOPE` | `0` (code) | Write-time composers stamp single-user-derived summary rows with that userId (≥2 users → proposal dropped); off = single-user content keeps folding into tenant-global rows. |

**Privacy fence order (existing deployments): migrate → backfill →
enable.** Run migrations through 0117, then
`POST /v1/admin/maintenance/segments/backfill-user-ids` once per
tenant, THEN flip `PRIVACY_SEGMENT_USER_FENCE` — the fence hides
un-backfilled legacy windows from user-scoped callers. Scenes need no
backfill — re-run the scene composer. For the composer rule there is no
backfill either: re-run the composers after enabling to rebuild the
derived set under the rule. `.env.example` ships BOTH fences `=1` on
purpose (default-off in code is for byte-identity only; they will
default on in a future release). While the segment fence is off and any
segment-serving mode is on, cross-user verbatim disclosure is possible.

### `OUTCOME_*` — outcome + decision telemetry (0107 / 0119)

| Flag | Default | Purpose |
|---|---|---|
| `OUTCOME_TELEMETRY_ENABLED` | `0` | Writers append `memory_outcome` events + fold the `memory_outcome_stat` rollup; nightly raw-log prune. Feeds verified-use decay/ranking (`SEARCH_VERIFIED_USE_*`). |
| `OUTCOME_RETRIEVED_EVENTS` | `0` | Extra gate on the high-volume `retrieved` stream (one event per surfaced fact per search). |
| `OUTCOME_EVENT_RETENTION_DAYS` | `30` | Raw event log retention (the stat rollup is never pruned). |
| `OUTCOME_TX_WRITES` | `0` | Transactional idempotent outcome writes (one BEGIN/COMMIT, deterministic ids, replay folds nothing twice). |
| `OUTCOME_DECISION_CAPTURE` | `0` | Content-free `memory_decision` rows at the abstain gate + L3 trigger (0119); independent master, not coupled to `OUTCOME_TELEMETRY_ENABLED`. |
| `OUTCOME_DECISION_RETENTION_DAYS` | `30` | Decision-row retention (03:41 UTC prune, gated on the capture flag). |

### `EXTRACTOR_*` — deterministic harvest lanes

Regex/lexicon lanes that run after the LLM extractor's denoise pass and
UNION extra mention candidates into the same pipeline — deterministic,
zero additional LLM calls. Prose reference:
[extraction-harvest-lanes.md](extraction-harvest-lanes.md).

| Flag | Default | Purpose |
|---|---|---|
| `EXTRACTOR_LITERAL_HARVEST` | `0` | Literal-fact harvest (`src/ai/extractor-internals/literal-harvest.ts`): regex rules emit `rate_limit`, `service_port`, `http_status`, `naming_prefix`, `identifier` mention candidates (cap 6/turn; attribution by clause overlap with speaker fallback). The sixth technical-literal core predicate, `duration_limit`, is seeded as an LLM slot only — its harvest rule ships disabled (the over-firing rule of the family). |
| `EXTRACTOR_STATE_VERB_HARVEST` | `0` | State-verb harvest (`src/ai/extractor-internals/state-verb-harvest.ts`): a past-tense/completed state-verb lexicon emits `state_change` facts (confidence 0.95, cap 6/turn). The fact binds to the state HOLDER — a person entity named in the sentence, else the speaker — never to the transitioned object. |
| `EXTRACTOR_TRANSITION_CLASSIFIER` | `0` | Availability gate ONLY in this release: the language-agnostic transition classifier (compromise morphology stage + BGE-M3 EN/RU prototype bank — `transition-morphology.ts` + `transition-classifier.ts`) exists as a standalone module but is NOT wired into the extraction pipeline yet; thresholds are exported defaults pending stand calibration. |

Related read-surface flags documented in [api.md](api.md):
`FACTS_API_ENABLED` (fact read + provenance, also registers the MCP
`get_fact` / `get_fact_provenance` tools), `BELIEFS_API_ENABLED`
(belief read API), `PROVENANCE_RECURSIVE_CLOSURE` /
`PROVENANCE_SUPPORT_GRAPH_READ` (provenance response extensions).

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
| `worker` | `CHAT_ROUTE_NLI_ENABLED=false` | Runs the queue loop + crons. Keeps the HTTP server up (healthcheck + `/v1/admin/*` need it) but the compose recipe publishes no ports. Skips the ~340MB NLI intent-classifier ONNX model — a worker pod doesn't chat-route. |

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
- ONNX models lazy-load where used: the NLI intent classifier (~340MB)
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
default; `RETRIEVAL_PROFILE_OVERRIDES` overlays per tenant. Resolution
order per key: explicit env var → the `RETRIEVAL_GENRE` preset
(`src/search/genre-presets.ts`; the genre defaults to `assistant_chat`)
→ the code fallback — so for an unset var the EFFECTIVE default is the
`assistant_chat` preset value, not necessarily the code fallback listed
below.

| Key | Default | What it does |
|---|---|---|
| `RETRIEVAL_GENRE` | `assistant_chat` | Names the corpus shape (`dialogue` \| `assistant_chat` \| `documents`) so per-tenant overrides read as intent. The dimensions the engine actually branches on are the two below. |
| `RETRIEVAL_VERBATIM_EVIDENCE` | `shape_conditioned` | How verbatim L0 evidence reaches answers: `off` (facts only), `shape_conditioned` (episode quotes + provenance excerpts only when the question asks for conversational content — the engine default), `always` (all verbatim lanes unconditionally as a prompt appendix; the diary-genre profile), `fused` (segments become scored, reranked, citable SearchHits inside the search pipeline instead of an appendix), `routed` (per-query dispatch: verbatim-shaped questions take the fused path, everything else stays shape_conditioned). |
| `RETRIEVAL_INSIGHT_EVIDENCE` | `off` | How derived insight rows (aspect aggregates + `summary_*` promotion/compaction summaries) reach answers: `off` (they ride the fact legs as ordinary rows), `routed` (fact legs exclude them; summarization/enumeration-routed questions retrieve them as their own dense+BM25 fused pool under a separate prompt slot — `INSIGHT_TOP_K`, not the fact budget). |
| `RETRIEVAL_TIMELINE_EVIDENCE` | `off` | `routed`: ordering/sequence-shaped questions (the order-lexicon) also get the chronological segment appendix — the occurredAt-ordered mention record. Event-time extraction collapses a session's mentions onto one `validFrom` date, so mention order is unrecoverable from facts alone. Skipped when the query's resolved verbatim mode is `fused`. `scan`: the mention record is built by the topic-scan lane instead of the top-K appendix — topic phrase extracted from the question, the segment record scanned per session (BM25+embedding against the TOPIC), one dated line per session-mention in occurredAt order; coverage bounded by session count, not top-K. |
| `RETRIEVAL_ABSTENTION_CALIBRATION` | `verifier` (effective — set by the default `assistant_chat` genre preset in `src/search/genre-presets.ts`; the bare-code fallback is `off`) | `coverage`: in strict/lenient guardrails, evidence must clear the coverage floor (best fact score ≥ `RETRIEVAL_ABSTENTION_MIN_SCORE`, default 0.35; fact count ≥ `RETRIEVAL_ABSTENTION_MIN_EVIDENCE`, default 2) before generation — below it synthesize returns an explicit not-in-my-memory answer (reason `low_coverage`). Note: retrieval-level floors cannot detect answer-absence on topically-adjacent questions (measured non-discriminative) — use for genuinely off-topic traffic. `verifier`: answer-level coverage — in lenient guardrails an unsupported/partial verifier verdict returns the explicit decline instead of ungrounded text (no extra LLM cost). `answer` guardrails are always exempt (caller-level never-abstain contract). |
| `RETRIEVAL_SALIENCE_SCORING` | off | Fold the deriver-stamped `source.salience` (0-3, written under `DERIVER_SALIENCE_STAMP`) into ranking — weights [0.8, 1.0, 1.1, 1.25] per grade. Unstamped rows sit on the neutral grade and are unaffected. Enable only against a salience-stamped derived world. |
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

## Long-lived DB sessions (why reads used to die after an hour)

`surrealdb-js` renews only the sessions it opened itself. When application
code calls `db.signin()`, the driver records `authOverriden` and its renewal
timer has nothing left to renew with — at `exp − 60s` it calls `invalidate()`
and the connection is **anonymous for the rest of the process**. Its own type
declarations say so: *"When this method is called, the `authentication`
property passed to `connect()` will be ignored. You will be responsible for
handling session invalidation."*

`DEFINE USER` issues a 1-hour access token by default, so any connection that
signs in once and lives forever goes anonymous about 59 minutes after boot.
Nothing expires server-side; `DURATION FOR SESSION NONE` does **not** help,
because the driver reads the JWT `exp` and never asks the server.

Every long-lived connection in brain therefore re-signs before that timer
fires. Both pools follow one discipline (`SurrealService.ensureSession`): on
every acquire, a connection whose socket is up and whose token has more than
5 minutes of life runs a `RETURN 1` probe (~0.3 ms; fails on a half-open
socket and on an anonymous session alike); otherwise it re-signs (~16 ms, the
server-side password KDF). If either fails the pool builds a replacement
first and closes the old connection only once the replacement signed in. The
root pool used to re-sign on every acquire instead — correct, but paying the
KDF on every write and admin query.

| Connection | Identity | On failure |
|---|---|---|
| Root pool (`withCompany`, `withAdminDb`, `dropCompanyDatabase`) and the migrator connection | root | Error propagates. |
| Scoped pool (`withScopedCompany` — every caller-facing read) | `brain_caller` | Fails **closed** with a 503 — never served root-authorized; the connection stays in the pool for the next acquire's retry. |
| LIVE subscription channels (`LIVE_SUBSCRIPTIONS_ENABLED`) | `brain_caller` when `SURREALDB_SCOPED_USER`/`_PASS` are set, **root otherwise** — a caller-facing read path, so configure the scoped user wherever LIVE is on; every pushed row still passes the app-layer policy filter (docs/abac.md § Which connection carries which identity) | Renewed on the catch-up tick (bounded by a timeout, ticks never stack); whatever the driver-side invalidate does to the standing `LIVE` query, the changefeed replay on the next tick delivers what it missed. |
| `scripts/backfill-lang-attribution.ts` | root | Re-signs per batch. |

Symptoms to recognise if this ever regresses: reads answer
`Anonymous access not allowed: Not enough permissions to perform this action`
while writes, `/health` and MCP keep working. `/ready` now catches it —
`pingScoped()` runs an authorization-gated statement on a scoped connection,
because `version()` (what `ping()` uses) is answered for anonymous sessions
too and reported "ok" throughout the original outage. `/ready` is only
polled at deploy time, though — the **continuous** signal is the
`scoped_read` capability probe (§ Capability probes), which runs the same
read path on a timer and alerts when it stops authorizing.

`SURREALDB_SCOPED_TOKEN_DURATION` declares the scoped user's token lifetime
(a SurrealDB duration literal; unset = the server's 1h default). It is a
tuning knob, not the fix — brain OVERWRITEs the user definition on every
boot, so it exists mainly so a duration set by hand on the server is not
silently discarded on the next deploy. A value at or below the 5-minute
re-auth margin is honoured but logged at error level: every scoped acquire
then re-signs, which only the expiry e2e wants.

## Capability probes

The failure class: **the service reports healthy while a whole capability is
dead.** Three instances in one week — the scoped pool going anonymous ~59
minutes after boot with `/health` green (#502), `/ready` green through
embedder warmup because it ORed in an always-ready fallback (#503), and
`POST /v1/ingest/mention` 400ing for six days from a two-flag interaction
(#510). The common property is a green signal that does not exercise the
thing it claims to cover.

`/ready` gained real checks in the first two fixes, but **readiness is polled
at deploy time**: a pool that lapses an hour after a successful deploy is
invisible to it by construction. The capability probe — on by default,
`CAPABILITY_PROBE_ENABLED=0` disables it — arms a timer (default 60s, every
pod, no leader lease — the failure is per-process) that RUNS each capability
and publishes what happened.

**Readiness vs traffic.** This is a single-replica deployment, and the
process degrades on its own: hybrid search answers lexical-only (marked
`degraded`) while the embedder warms or is down, scoped reads answer 503
while writes keep working. Traefik therefore health-checks `/health`
(liveness — a wedged process answers 503 at the edge instead of hanging
clients) and deliberately **not** `/ready`: pulling the only replica out of
rotation on a partial failure would turn it into a total one. `/ready` is the
deploy-time check (the workflow waits up to five minutes for it and fails
the job — not the rollout — if it never goes green) and the readinessProbe
for a multi-replica layout. The continuous signal between deploys is the
probe below; the actuator for what it finds is the runbook, because after
#502 every self-healable failure already heals itself.

| Capability | What the probe actually does | Covers `/ready` check |
|---|---|---|
| `scoped_read` | `withScopedCompany(canary tenant, ['brain:read'], SELECT VALUE id FROM knowledge_fact LIMIT 1)` — acquire → renew-or-fail-closed → `use(co_<tenant>)` → schema check → scope binding → an authorization-gated read of a real table. An empty result is a pass: the question is "was this authorized", not "is there data". | `dbOk`, `scopedOk` |
| `embed` | Embeds a short string **uncached** and compares the width of the returned vector against the configured (primary) space. Not `isReady()` — that is the component's opinion of itself, and in #503 the opinion was green while every vector came back 1536 wide for a 1024-wide corpus. | `embedderReady` |

Outcomes, and why `busy` is not a failure:

| Outcome | Meaning | Moves the up-gauge? |
|---|---|---|
| `serving` | Exercised end to end, produced the expected result. | yes → 1 |
| `unauthorized` | Alive but refusing — the session can no longer authorize. **This is #502's exact state.** | yes → 0 |
| `degraded` | Answered, wrong property — a vector outside the configured space. **#503's exact state.** | yes → 0 |
| `busy` | Pool acquire timed out. The pool is answering, just not us. | **no** — the previous value stands |
| `error` | Anything else (unreachable, statement threw, probe deadline). | yes → 0 |
| `skipped` | Nothing to exercise (no tenant in the roster, no embedder in this process). | no |

A saturated pool must not page anyone — the same call `pingScoped()` makes
in readiness (#502) — so that distinction lives in the metric itself, not in
an alert threshold: `brain_capability_probe_ok` is written **only** on a
conclusive outcome.

### Metrics and alerts

| Series | Use |
|---|---|
| `brain_capability_probe_ok{capability}` | 1/0 up-signal. Absent until the first conclusive probe, so a booting pod is *absent*, not *down*. |
| `brain_capability_probe_total{capability,outcome}` | Rates per outcome. A steady `busy` rate is a capacity signal, not a health one. |
| `brain_capability_probe_last_success_timestamp_seconds{capability}` | Catches what the up-gauge cannot: a wedged prober, or a pool that has been nothing but busy. |
| `brain_capability_probe_armed_timestamp_seconds{capability}` | Written at bootstrap, before the first tick, so a capability that has **never** succeeded reads as a large age in `CapabilityProbeStale` (`last_success or armed`) instead of as absence. Withdrawn for a capability whose probe reports `skipped` (no embedder wired, no tenant yet), so a legitimately idle capability does not page. |

No `companyId` label anywhere (the standing cardinality rule): one scoped
session serves every tenant on the pod, so the canary tenant proves the
property for all of them and the scraper's `instance` label already pins
*which pod*. The tenant is named in the log line.

**The canary tenant** is the first (sorted) id of the tenant registry's
*active* roster — the same roster provisioning and every sweep should use;
the static `BRAIN_API_KEYS` set stands in only where the registry knows
nothing (dev, a fresh install). `CAPABILITY_PROBE_TENANT` pins one, and it
**must name a tenant the process already knows**: the scoped path provisions
the database it is handed, so a typo used to create `co_<typo>` with the full
migration set on every boot. An unknown or suspended override is refused
before any connection is taken and reported as a conclusive `error` — it
pages, on purpose, as a configuration error.

**`degraded` is reachable both ways.** With the strict space guard on (the
default) a not-warm primary never returns a wrong-width vector — the
embedder refuses the call with its "embedding space strict-guard" 503, and
the probe reads that refusal as `degraded`. With the guard off the fallback
answers in its own space and the width measurement catches it.

**The admin cockpit shows the same thing.** `/v1/admin/health/components`
reads the readiness report `/ready` answers from (database, scoped pool with
its own row, embedder with the warmup bookkeeping — attempts, last error,
next retry) and annotates each row with the probe's last outcome (`probe
serving 12s ago`). It does not probe on its own, so the grid, `/ready` and
the alert cannot disagree.

Rules in `monitoring/grafana/provisioning/alerting/rules.yaml`:

- **ScopedReadCapabilityDead** (critical, `for: 5m`) — `min(brain_capability_probe_ok{capability="scoped_read"}) < 1`. Five consecutive conclusive failures at the default cadence. A lapsed session is no longer sticky (the pool re-signs on the next acquire), so five failures in a row mean the pool cannot sign in at all; the wait buys immunity from a single-tick blip.
- **CapabilityProbeFailing** (warning, `for: 20m`) — the same check for every *other* capability, so a newly added one is alerted on without anyone remembering to write a rule. Long window because `embed` is legitimately 0 during a cold bge-m3 warmup.
- **CapabilityProbeStale** (warning) — no confirmed serve for 30m.

### When ScopedReadCapabilityDead fires

1. The `instance` label names the pod. Reads are failing **there** while
   writes, `/health` and MCP may still answer — see § Long-lived DB sessions
   for why.
2. **Do not start with a restart.** The pool re-signs a lapsed session on
   the next acquire and rebuilds a dead socket, so a probe that stays
   `unauthorized` means the pool cannot *sign in* — a restart reproduces the
   same failure. Read the probe's error log: it carries the DB's own message.
3. `There was a problem with authentication` / `not found` → check
   `SURREALDB_SCOPED_USER` / `SURREALDB_SCOPED_PASS` against the server and
   that migration 0005's `brain_caller` still exists (`INFO FOR NS` on the
   brain namespace). Brain OVERWRITEs the user on boot from those two
   variables, so a rotated secret takes effect on the next deploy.
4. `timed out` → the rebuild could not replace a wedged socket (half-open
   TCP to the DB). Check the DB container and the network first; restart
   the pod only if the DB is healthy and the timeouts persist.
5. `brain_capability_probe_total{outcome="busy"}` climbing instead means
   saturation, not authorization — that is a pool-size / slow-query problem
   and never fires this alert.

## Boot-time validation

The service runs `validateEnv()` before NestJS starts. Missing or
malformed values produce a single multi-line error and exit code 1.
This is intentional — better to refuse to start than to dribble out
500s under load.

## Graceful shutdown

`SIGTERM` and `SIGINT` close the SurrealDB connection and drain in-
flight requests. A 15s deadline guards against a hung shutdown so
docker / fly / k8s don't `SIGKILL` you with no log line.

## Deploys, and how to undo one

The engine deploy does not build. CI builds the image once, pushes it,
pulls the published **digest** back, smoke-tests that, and records it in a
`deploy-manifest` artifact. `deploy-brain.yml` waits for CI's verdict on
its own commit, reads that manifest, and pins
`inite-brain-service@sha256:…` in the compose file. A tag is never
deployed: `:latest` resolves to whatever the registry holds at pull time
and cannot carry the claim "this is what CI tested".

Consequences worth knowing:

- **A red `main` does not deploy.** The `verify` job fails and nothing
  downstream runs. So does "CI never ran for this commit" and "CI is still
  running 45 minutes later" — not being able to confirm green is not
  permission to ship.
- **The commit and the running image are the same thing.**
  `docker inspect inite-brain-service --format '{{index .RepoDigests 0}}'`
  on the box gives you a digest you can match against the CI run that
  produced it.

### Verification after a deploy

Two internal gates on the box (`/health` for liveness, `/ready` for the
database, scoped authorization and the primary embedder), then an external
`smoke` job that goes through DNS, the certificate and Traefik —
`scripts/ci/smoke.mjs`, surface `brain`. It asserts more than liveness: an
unauthenticated `POST /v1/search` must return **401**. A 404 means the API
is not mounted; a 200 means auth is not enforced. Only 401 says the
surface is there and fail-closed.

The landing has its own surface (`/en`, `/skills.tar.gz`, `/install.sh`,
`/openapi.json`) and deliberately does **not** assert `/health` — Traefik
routes that path to the engine, so asserting it made the landing's release
gate on a different service's health.

### Rollback

Three files live in `/opt/projects/inite-brain-service/`:

| File | Meaning |
|---|---|
| `.pending-image` | the digest this run is deploying |
| `.previous-image` | whatever was pinned before this run started |
| `.last-good-image` | the last digest that passed **both** the readiness gate and the external smoke test |

`.last-good-image` is written only by the `finalize` job, only when the
smoke test passed. It is a known-good target rather than merely a previous
one — which matters, because rolling back to a previous deploy that was
itself broken achieves nothing.

**Automatic.** If the deploy job or the smoke job fails, `finalize`
rewrites the compose image to `.last-good-image` (falling back to
`.previous-image`), pulls, restarts, and then waits for `/ready` on the
rolled-back container. It reports the run as **failed** even when the
rollback succeeds — production is safe, but the commit on `main` is still
broken and needs a fix-forward or a revert.

**By hand.** Actions → *Deploy brain.inite.ai* → Run workflow →
`action: rollback`. This skips verification entirely (it must work while
CI is red — that is what it is for) and redeploys `.last-good-image`.

**When there is nothing to roll back to** — a first deploy, or a host
whose state files were wiped — the rollback step says so and exits 1
rather than pretending. Recover by pinning a digest by hand:

```bash
cd /opt/projects/inite-brain-service
sed -i 's|^\( *image:\).*|\1 <user>/inite-brain-service@sha256:…|' docker-compose.yml
docker-compose pull inite-brain-service && docker-compose up -d
```

A `rollback` cannot cross a database migration. Migrations run forward on
boot and are not reversed by pinning an older image; if the bad deploy
introduced a schema change, roll back the image to stop the bleeding and
then handle the schema deliberately.

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

## Eval stand

Idioms for accelerated benchmark legs (LoCoMo / LongMemEval / BEAM)
against a local stand — mistakes here burn paid multi-hour runs:

- **`THROTTLE_DISABLED=1` is REQUIRED for accelerated ingest legs.**
  The per-route `@Throttle` decorators do NOT read the env rate-limit
  values — only the throttler master switch disables them. Without it
  the brain's own throttler 429s the eval runner at ~120 req/min
  (`ThrottlerException` — easily misread as an OpenAI 429) and a
  multi-hour ingest dies mid-flight. Never set it in production.
- One heavy chain (ingest or QA) per SurrealDB stand container at a
  time — two concurrent chains have OOM'd a 4-GB stand repeatedly.
- Fresh tenant per write-leg attempt (mint a new single-tenant API
  key), so lazy per-tenant migrations and half-written substrates can
  never contaminate a pair.
- Gate chain steps on CHECKPOINT COMPLETENESS (row count in the
  `--resume` file), not runner exit codes — the runners exit 0 with
  errored rows.

## See also

- [Operator playbook](operator-playbook.md) — day-2 troubleshooting runbooks.
- [Deploy runbook](DEPLOY.md) — the production deployment + observability stack.
- [API reference](api.md) — the endpoint families these flags gate.
- [Document pipeline](document-pipeline.md) — the architecture behind the pipeline flags.
