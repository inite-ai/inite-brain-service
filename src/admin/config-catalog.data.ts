/* eslint-disable max-lines -- one declarative catalogue literal; splitting it would only scatter the sections */
import type { ConfigEntry } from './config-inspector.service';

/** One catalogue row — a ConfigEntry before the live value is projected. */
export type ConfigCatalogSpec = Omit<ConfigEntry, 'currentValue'> & {
  defaultValue: string | null;
};

/**
 * Catalogue of operator-visible env knobs — ONE big declarative literal
 * by design (curated descriptions + correct restart-required flags; see
 * ConfigInspectorService). NEW knobs: add an entry here, keep the
 * section comments. Extracted from the service purely for file-size
 * reasons; the service projects live values over it.
 */
export const CONFIG_CATALOG: ConfigCatalogSpec[] = [
      // ── Extractor ────────────────────────────────────────────
      {
        key: 'EXTRACTOR_SKIP_LLM_ENABLED',
        category: 'extractor',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Opt-in gate that allows the local pre-pass to skip the extractor LLM call when intent + mentions + collapse-patterns all hit.',
      },
      {
        key: 'EXTRACTOR_SC_PASSES',
        category: 'extractor',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Self-consistency N-pass count for semantic-entropy gating. 1 = single pass; raise (e.g. 3) for high-stakes corpora.',
      },
      {
        key: 'EXTRACTOR_LOCAL_NER_ENABLED',
        category: 'extractor',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description: 'Local @xenova/transformers NER pass before the LLM.',
      },
      {
        key: 'EXTRACTOR_LOCAL_NER_MIN_SCORE',
        category: 'extractor',
        defaultValue: '0.7',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'EXTRACTOR_LOCAL_NER_MODEL',
        category: 'extractor',
        defaultValue: 'Xenova/bert-base-multilingual-cased-ner-hrl',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'EXTRACTOR_LOCAL_NER_WORKER',
        category: 'extractor',
        defaultValue: '1',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Run the local NER ONNX pipeline in a dedicated worker_thread so inference never blocks the event loop. 0 = in-thread.',
      },
      {
        key: 'EXTRACTOR_LOCAL_NER_TIMEOUT_MS',
        category: 'extractor',
        defaultValue: '3000',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Per-call budget for the NER worker RPC; a stalled call degrades to "no local entities" and latches worker retries for 5 minutes.',
      },
      {
        key: 'EXTRACTOR_LOCAL_PREDICATE_THRESHOLD',
        category: 'extractor',
        defaultValue: '0.55',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'EXTRACTOR_CACHE_ENABLED',
        category: 'extractor',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'EXTRACTOR_CACHE_SIZE',
        category: 'extractor',
        defaultValue: '256',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      // ── Embedder ────────────────────────────────────────────
      {
        key: 'EMBEDDER_PROVIDER',
        category: 'embedder',
        defaultValue: 'openai',
        runtimeMutable: false,
        isBooleanFlag: false,
        description: 'openai | bge-m3. Requires reindex after flip.',
      },
      {
        key: 'BGE_M3_MODEL_ID',
        category: 'embedder',
        defaultValue: 'Xenova/bge-m3',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'BGE_M3_DIMENSIONS',
        category: 'embedder',
        defaultValue: '1024',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'BGE_M3_CONCURRENCY',
        category: 'embedder',
        defaultValue: '2',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      // ── Dreams ────────────────────────────────────────────
      {
        key: 'DREAMS_ENABLED',
        category: 'dreams',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Master switch for the 04:00 UTC cron. Read once at boot.',
      },
      {
        key: 'DREAMS_DEDUP_ENABLED',
        category: 'dreams',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'DREAMS_RESOLVE_ENABLED',
        category: 'dreams',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'DREAMS_RUN_SUMMARIZE',
        category: 'dreams',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'DREAMS_LLM_SUMMARY_ENABLED',
        category: 'dreams',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
      },
      {
        key: 'DREAMS_DEDUP_COSINE_THRESHOLD',
        category: 'dreams',
        defaultValue: '0.92',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'DREAMS_DEDUP_MAX_PAIRS',
        category: 'dreams',
        defaultValue: '50',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'DREAMS_DEDUP_MAX_SEEDS',
        category: 'dreams',
        defaultValue: '500',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Cap on name-fact seeds per dedup run (newest first). Bounds the per-seed neighbour queries.',
      },
      {
        key: 'DREAMS_RESOLVE_MIN_AGE_DAYS',
        category: 'dreams',
        defaultValue: '7',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'DREAMS_RESOLVE_MAX_PAIRS',
        category: 'dreams',
        defaultValue: '20',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      // ── Compaction ────────────────────────────────────────────
      {
        key: 'COMPACTION_HOT_RETENTION_DAYS',
        category: 'compaction',
        defaultValue: '90',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'COMPACTION_SUMMARIES',
        category: 'compaction',
        defaultValue: 'false',
        runtimeMutable: false,
        isBooleanFlag: true,
      },
      // ── Audit / changefeed ────────────────────────────────────
      {
        key: 'AUDIT_CHANGEFEED_ENABLED',
        category: 'audit',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Master switch for the every-minute changefeed → audit_event consumer.',
      },
      {
        key: 'AUDIT_CHANGEFEED_BATCH',
        category: 'audit',
        defaultValue: '500',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      // ── Router ────────────────────────────────────────────────
      {
        key: 'CHAT_ROUTE_CACHE_ENABLED',
        category: 'router',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'CHAT_ROUTE_CACHE_SIZE',
        category: 'router',
        defaultValue: '256',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CHAT_ROUTE_HINT_MAX',
        category: 'router',
        defaultValue: '3',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CHAT_ROUTE_HINT_SIMILARITY',
        category: 'router',
        defaultValue: '0.55',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CHAT_ROUTE_INTENT_CONFIDENCE_FLOOR',
        category: 'router',
        defaultValue: '0.85',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CHAT_ROUTE_NLI_ENABLED',
        category: 'router',
        // Code default is ON (`get('CHAT_ROUTE_NLI_ENABLED', 'true') !==
        // 'false'` in IntentClassifierService) and captured in the
        // constructor — the previous '0'/runtime-mutable entry was drift.
        defaultValue: '1',
        runtimeMutable: false,
        isBooleanFlag: true,
      },
      {
        key: 'CHAT_ROUTE_NLI_ASK_THRESHOLD',
        category: 'router',
        defaultValue: '0.6',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CHAT_ROUTE_NLI_WORKER',
        category: 'router',
        defaultValue: '1',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Run NLI intent inference in a dedicated worker_thread so the ~100-200ms ONNX pass never blocks the event loop. 0 = in-thread (benchmarks/constrained envs).',
      },
      {
        key: 'CHAT_ROUTE_NLI_TIMEOUT_MS',
        category: 'router',
        defaultValue: '3000',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Per-call deadline for the NLI worker RPC. On timeout the router keeps the punctuation fallback and the classifier latches off for 5 minutes.',
      },
      // ── Search ────────────────────────────────────────────
      {
        key: 'SEARCH_PPR_ENABLED',
        category: 'search',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'SEARCH_PPR_AUTO_THRESHOLD',
        category: 'search',
        defaultValue: '3',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'SEARCH_RERANKER_ENABLED',
        category: 'search',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'SEARCH_CROSS_ENCODER_ENABLED',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'SEARCH_RERANK_SKIP_MARGIN',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'SEARCH_PREDICATE_ROUTER_ENABLED',
        category: 'search',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'SEARCH_TOKEN_COUNT_OFFLOAD',
        category: 'search',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Batch tokenBudget tiktoken counting out to the job worker pool (25ms acquire timeout; any failure falls back to the in-thread count).',
      },
      {
        key: 'SEARCH_TOKEN_OFFLOAD_MIN_HITS',
        category: 'search',
        defaultValue: '24',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Hit-count threshold below which tokenBudget counting stays in-thread — the postMessage round-trip only pays off on large lists.',
      },
      {
        key: 'MULTI_HOP_EDGE_EXPANSION_ENABLED',
        category: 'multihop',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      // ── Calibration ────────────────────────────────────────────
      {
        key: 'CALIBRATION_NIGHTLY_REFIT',
        category: 'calibration',
        defaultValue: 'true',
        runtimeMutable: false,
        isBooleanFlag: true,
      },
      {
        key: 'CALIBRATION_USE_GOLD_SET',
        category: 'calibration',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      // ── Cost ────────────────────────────────────────────
      {
        key: 'COST_CHAT_PROMPT_USD_PER_MTOK',
        category: 'cost',
        defaultValue: '0.15',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'COST_CHAT_COMPLETION_USD_PER_MTOK',
        category: 'cost',
        defaultValue: '0.6',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'COST_EMBED_USD_PER_MTOK',
        category: 'cost',
        defaultValue: '0.02',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      // ── Throttle ────────────────────────────────────────────
      {
        key: 'THROTTLE_TTL_MS',
        category: 'throttle',
        defaultValue: '60000',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'THROTTLE_LIMIT',
        category: 'throttle',
        defaultValue: '120',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'THROTTLE_EXPENSIVE_TTL_MS',
        category: 'throttle',
        defaultValue: '60000',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'THROTTLE_EXPENSIVE_LIMIT',
        category: 'throttle',
        defaultValue: '10',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      // ── Jobs / trace persistence ────────────────────────
      {
        key: 'JOB_RUN_PERSIST',
        category: 'jobs',
        defaultValue: '1',
        runtimeMutable: false,
        isBooleanFlag: true,
      },
      {
        key: 'DEBUG_TRACE_PERSIST',
        category: 'jobs',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
      },
      {
        key: 'DEBUG_TRACE_DB_CAPACITY',
        category: 'jobs',
        defaultValue: '1000',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      // ── Auth / OpenAI ────────────────────────────────────────
      {
        key: 'JWKS_URL',
        category: 'auth',
        defaultValue: null,
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'OPENAI_API_KEY',
        category: 'auth',
        defaultValue: null,
        runtimeMutable: false,
        isBooleanFlag: false,
        secret: true,
      },
      {
        key: 'OPENAI_CHAT_MODEL',
        category: 'auth',
        defaultValue: 'gpt-4o-mini',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'OPENAI_EMBEDDING_MODEL',
        category: 'auth',
        defaultValue: 'text-embedding-3-small',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'OPENAI_TIMEOUT_MS',
        category: 'auth',
        defaultValue: '30000',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'OPENAI_MAX_RETRIES',
        category: 'auth',
        defaultValue: '3',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'OPENAI_CONCURRENCY',
        category: 'auth',
        defaultValue: '6',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      // ── Conflict resolution weights ────────────────────────
      {
        key: 'CONFLICT_WEIGHT_AUTHORITY',
        category: 'conflict',
        defaultValue: '0.1',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CONFLICT_WEIGHT_CONFIDENCE',
        category: 'conflict',
        defaultValue: '0.3',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CONFLICT_WEIGHT_RECENCY',
        category: 'conflict',
        defaultValue: '0.2',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CONFLICT_WEIGHT_SOURCE_TRUST',
        category: 'conflict',
        defaultValue: '0.4',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CONFLICT_MARGIN_SUPERSEDE',
        category: 'conflict',
        defaultValue: '0.15',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CONFLICT_REJECT_THRESHOLD',
        category: 'conflict',
        defaultValue: '0.3',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CONFLICT_SIMILARITY_THRESHOLD',
        category: 'conflict',
        defaultValue: '0.85',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      // ── ABAC (migrations 0056/0057) ──────────────────────────
      {
        key: 'ABAC_ENABLED',
        category: 'auth',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Master switch for attribute-based access control. Off = the policy resolver never runs; keys behave byte-identically to pre-ABAC.',
      },
      {
        key: 'ABAC_FORCE_REPORT_ONLY',
        category: 'auth',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Emergency demote-all: every enforce set behaves report_only (logged, never blocks). Rollback lever for a bad policy.',
      },
      {
        key: 'ABAC_DB_FENCE_ENABLED',
        category: 'auth',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'DB-level PERMISSIONS PII fence (0057). Inert for the system-user pool — the app-layer JS filter is the enforcing gate.',
      },
      {
        key: 'SOURCE_META_STRICT',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'On = ingest 400s on an invalid source.meta entry instead of dropping it (a silently-dropped data_class would widen access).',
      },
      {
        key: 'POLICY_META_UNION_ENABLED',
        category: 'auth',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Effective-meta union: a corroborated fact inherits its confirming documents’ meta for DENY evaluation (union = most restrictive).',
      },
      // ── Document pipeline (migrations 0048–0050) ─────────────
      {
        key: 'DOCUMENT_INGEST_ENABLED',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Master switch for POST /v1/ingest/document + the /v1/documents/* surface. Off = every route 503s.',
      },
      {
        key: 'DOCUMENT_MULTI_INDEXER_ENABLED',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Dedicated per-pack indexer runs + relevance router + async fan-out + external work items. Off = only the generalist union pass runs.',
      },
      {
        key: 'PACK_SEED_INGEST_ENABLED',
        category: 'pipeline',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Ingest a pack’s seedDocuments through the document pipeline on install (pack_seed_ingest job). Requires DOCUMENT_INGEST_ENABLED; when either is off the install response reports a skip — install never fails because of seeds.',
      },
      {
        key: 'INDEXER_EXTERNAL_PENDING_TTL_DAYS',
        category: 'pipeline',
        defaultValue: '7',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'How long an unclaimed external work item (pending external indexer_run, GET /v1/indexer/work) stays pollable before the nightly sweep expires it. Claimed work rides INDEXER_RUN_STALE_MINUTES via heartbeat.',
      },
      {
        key: 'INDEXER_WEBHOOK_PUSH_ENABLED',
        category: 'pipeline',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Signed work_available webhook hints to external packs declaring indexer.external.callbackUrl. Best-effort (retries + per-URL breaker); polling stays the source of truth.',
      },
      // ── Search: retrieval-evolution stages (migrations 0052–0055) ──
      {
        key: 'SEARCH_HNSW_ENABLED',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Switch the KNN vector leg on. Tenants without a built index fall back to the full scan; build via POST /v1/admin/maintenance/hnsw.',
      },
      {
        key: 'SEARCH_QUERY_EXPANSION_ENABLED',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'LLM rewrites the query into N variants before search. Fails open to the raw query on error.',
      },
      {
        key: 'SEARCH_USAGE_RECORDING_ENABLED',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description: 'Record lastReadAt on retrieved facts (feeds recency decay).',
      },
      {
        key: 'SEARCH_USAGE_DECAY_ENABLED',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Count recency decay from lastReadAt, not only recordedAt (needs recording on for data).',
      },
      {
        key: 'SEARCH_EDGE_EXPANSION_ENABLED',
        category: 'search',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Graph-walk from top seeds to pull in 1-hop neighbours (default ON). Knobs: SEARCH_EDGE_EXPANSION_TOP_SEEDS/_MAX_NEIGHBOURS/_ALPHA.',
      },
      {
        key: 'SEARCH_EDGE_EXPANSION_TOP_SEEDS',
        category: 'search',
        defaultValue: '3',
        runtimeMutable: true,
        isBooleanFlag: false,
        description: 'How many top-ranked seeds edge-expansion walks from.',
      },
      {
        key: 'SEARCH_EDGE_EXPANSION_MAX_NEIGHBOURS',
        category: 'search',
        defaultValue: '5',
        runtimeMutable: true,
        isBooleanFlag: false,
        description: 'Max neighbours pulled per seed during edge-expansion.',
      },
      {
        key: 'SEARCH_EDGE_EXPANSION_ALPHA',
        category: 'search',
        defaultValue: '0.4',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Inherited-score multiplier for an expanded neighbour (≤0.4 so a neighbour can never outrank its seed).',
      },
      {
        key: 'SEARCH_HYPE_ENABLED',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Hypothetical-embedding (HyDE-style) alt-vector leg. Read side degrades cleanly when altEmbedding is absent.',
      },
      {
        key: 'SEARCH_CROSS_ENCODER_LOCAL',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Run the local cross-encoder reranker (no Cohere key). Note: opting in enables the stage even with SEARCH_CROSS_ENCODER_ENABLED=0.',
      },
      // ── Dreams: corroboration + communities ──────────────────
      {
        key: 'DREAMS_CORROBORATE_ENABLED',
        category: 'dreams',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Fuzzy cross-source corroboration (cosine-close facts confirm each other). Bounded by DREAMS_CORROBORATE_MAX_PAIRS per run.',
      },
      {
        key: 'DREAMS_CORROBORATE_MAX_LLM_CALLS',
        category: 'dreams',
        defaultValue: '40',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Hard ceiling on judge LLM calls per corroborate run (default 2× MAX_PAIRS). different/unsure verdicts never count toward MAX_PAIRS, so this is what actually bounds spend.',
      },
      {
        key: 'DREAMS_COMMUNITIES_ENABLED',
        category: 'dreams',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description: 'Build + persist entity-community summaries during dreams.',
      },
      {
        key: 'COMMUNITIES_LP_OFFLOAD_MIN_EDGES',
        category: 'dreams',
        defaultValue: '2000',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Edge count from which community label propagation runs on the job worker pool instead of the main thread (needs JOB_WORKER_POOL_SIZE > 0; pool failures fall back in-thread). 0 = never offload.',
      },
      // ── Compaction: promotion ────────────────────────────────
      {
        key: 'COMPACTION_PROMOTION_ENABLED',
        category: 'compaction',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Promote old corroborated append_only fact groups into a durable summary. Bounded by COMPACTION_PROMOTION_MAX_GROUPS per run.',
      },
      // ── Jobs ─────────────────────────────────────────────────
      {
        key: 'JOBS_QUEUE_MODE',
        category: 'jobs',
        defaultValue: 'enqueue',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Where background jobs run: enqueue (durable worker loop, default) vs inline (in-process).',
      },
      {
        key: 'WORKER_LOOP_MAX_CONCURRENT',
        category: 'jobs',
        defaultValue: '1',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Max in-flight dispatches per jobType in the queue poller; 1 = original serial loop. Per-type override: WORKER_LOOP_MAX_CONCURRENT_<JOBTYPE>.',
      },
      {
        key: 'WORKER_LOOP_TENANT_MAX_CONCURRENT',
        category: 'jobs',
        defaultValue: '1',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Max in-flight dispatches per (jobType, tenant) — extra concurrency slots go to other tenants first.',
      },
      {
        key: 'WORKER_LOOP_GLOBAL_MAX_CONCURRENT',
        category: 'jobs',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Cap on in-flight dispatches across all jobTypes in this process; 0 = uncapped.',
      },
      // ── Registry mirroring (pull-only, migration 0064) ───────
      {
        key: 'REGISTRY_UPSTREAM_URL',
        category: 'registry',
        defaultValue: null,
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Base URL of the upstream Brain instance whose pack registry this one mirrors. Unset = mirroring off (no job registered); restart required to turn on/off.',
      },
      {
        key: 'REGISTRY_UPSTREAM_TOKEN',
        category: 'registry',
        defaultValue: null,
        runtimeMutable: true,
        isBooleanFlag: false,
        secret: true,
        description:
          'Bearer token sent on upstream /v1/registry reads (brain:read key on the upstream). Optional.',
      },
      {
        key: 'REGISTRY_MIRROR_INTERVAL_HOURS',
        category: 'registry',
        defaultValue: '24',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Mirror sync cadence in hours. The hourly :26 UTC cron collapses ticks inside one interval bucket via dedup key.',
      },
      {
        key: 'PROCESS_ROLE',
        category: 'jobs',
        defaultValue: 'all',
        runtimeMutable: false,
        isBooleanFlag: false,
        description:
          'Boot-only role split: all (default, single do-everything process), api (applies WORKER_LOOP_ENABLED=0 + JOB_WORKER_POOL_SIZE=0 unless set explicitly), worker (applies CHAT_ROUTE_NLI_ENABLED=false unless set). api/worker require JOBS_QUEUE_MODE=enqueue — validated at boot. See docs/operations.md "Splitting API and worker roles".',
      },
];
