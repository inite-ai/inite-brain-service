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
      // ── MCP pack tools (migration 0068) ───────────────────────
      {
        key: 'MCP_PACK_TOOLS_ENABLED',
        category: 'misc',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Master switch for pack-declared MCP tools (installed packs with a consented mcpTools section). Off = the MCP surface is exactly the static tool families.',
      },
      {
        key: 'MCP_PACK_QUERY_TOOLS_ENABLED',
        category: 'misc',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Declarative query tools (search / facts_by_predicate over the pack’s own predicates). Default ON under the master flag; only reachable when MCP_PACK_TOOLS_ENABLED=1.',
      },
      {
        key: 'MCP_PACK_EXTERNAL_TOOLS_ENABLED',
        category: 'misc',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'HMAC-signed HTTPS proxy tools to publisher endpoints (opaque installId on the wire, never companyId). Off = external tool specs are ignored even when consented.',
      },
      {
        key: 'MCP_PACK_TOOLS_ALLOW_HTTP',
        category: 'misc',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Dev/test ONLY: permit plain-http + loopback/private external tool endpoints (disables the SSRF egress guard). Never enable in production.',
      },
      {
        key: 'MCP_PACK_TOOLS_CACHE_TTL_MS',
        category: 'misc',
        defaultValue: '30000',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'TTL of the per-tenant pack-tool binding cache on the MCP hot path. Install/uninstall invalidate immediately; the TTL covers out-of-band domain_pack edits.',
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
        key: 'SEARCH_CHATTER_PENALTY',
        category: 'search',
        defaultValue: '1.0',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Sub-1.0 ranking multiplier on low-value "said" chatter facts so substantive facts of the same entity are not buried. 1.0 = off; a demotion needs a value in (0,1), e.g. 0.35.',
      },
      {
        key: 'SEARCH_FACTS_PER_ENTITY',
        category: 'search',
        defaultValue: '5',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Max facts rendered per entity into a search hit / the synthesis prompt. Raise (e.g. 10) so a substantive fact on a fact-dense entity is not clipped by the window.',
      },
      {
        key: 'SEARCH_BACKFILL_PER_PREDICATE',
        category: 'search',
        defaultValue: '1',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Max backfill facts per predicate per entity. 1 = the historical one-fact-per-novel-predicate rule; 2 lets a crisp same-predicate fact surface when another already matched.',
      },
      {
        key: 'SEARCH_OCCLUSION_ENABLED',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Occlusion ranking: fill hit fact-windows front-to-back by score, where a kept fact suppresses later candidates whose embedding cosine is at or above SEARCH_OCCLUSION_THRESHOLD (globally across hits); each freed per-entity slot refills with the next non-duplicate fact, converting redundancy into coverage at the same context size. Read-path only; costs one bounded embedding fetch per search.',
      },
      {
        key: 'SEARCH_OCCLUSION_THRESHOLD',
        category: 'search',
        defaultValue: '0.9',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Cosine at or above which a kept fact occludes a candidate, clamp (0,1]. Basis-dependent: retune when the fact-embedding text changes (INGEST_CONTEXTUAL_FACT_EMBEDDING).',
      },
      {
        key: 'SEARCH_OCCLUSION_WINDOW',
        category: 'search',
        defaultValue: '24',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Candidate rows per entity (matched and backfill each) considered by occlusion — bounds the embedding fetch and the refill depth.',
      },
      {
        key: 'SEARCH_OCCLUSION_DATE_GUARD_DAYS',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Temporal ablation guard: occlusion only fires between facts whose validFrom differ by at most N days, so recurring dated events keep their distinct evidence lines. 0 = guard off (any distance occludes).',
      },
      {
        key: 'SEARCH_FACT_CENTRIC_ENABLED',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Fact-centric selection (Phase A, typed-memory roadmap): facts compete globally by score for the response window instead of entities, drawing from ALL scored buckets — removes the top-limit entity gate that hid a gold fact whose entity missed the entity ranking. Skips backfill; entity count follows the fact budget.',
      },
      {
        key: 'SEARCH_FACT_CENTRIC_BUDGET',
        category: 'search',
        defaultValue: '48',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Global fact budget for fact-centric selection — total facts kept across all entities (also used as the per-entity render cap under the flag).',
      },
      {
        key: 'MULTI_HOP_SYNTH_EVIDENCE_UNION',
        category: 'multihop',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Hand every hop’s retrieved hits to synthesis as extra evidence. Without it the synthesizer re-searches anchored to the final entity set only, so evidence from entities the chain filtered out can never be cited. Extras append best-score-first under SYNTHESIZE_EXTRA_EVIDENCE_CAP.',
      },
      {
        key: 'SYNTHESIZE_EXTRA_EVIDENCE_CAP',
        category: 'pipeline',
        defaultValue: '40',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Max pre-retrieved extra facts (multi-hop evidence union) appended to the generator prompt after the re-search results.',
      },
      {
        key: 'SYNTHESIZE_DATE_CONTEXT',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Prepend an anchored "Today: <date>" (dto.asOf, else now) plus a date-arithmetic instruction to the answer generator, so relative time expressions resolve against fact date stamps instead of being guessed.',
      },
      {
        key: 'EPISODE_SUBSTRATE_ENABLED',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'L0 episode substrate (memory-substrate-redesign P1): store every ingested dialogue turn verbatim (P0-redacted, piiClass-tagged) BEFORE extraction — lossless, idempotent (INSERT IGNORE on conversationId+messageId), LLM- and embedder-free. Extraction failures stop losing turns; future derivers re-derive from here.',
      },
      {
        key: 'SEARCH_EPISODIC_LANE_ENABLED',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Episodic retrieval lane (memory-substrate P2): BM25 top-k over the L0 episode substrate rendered as dated, chronological transcript quotes in their own generator-prompt section — the lossless fallback when extraction missed or fragmented a fact. Callers without brain:read_pii only see piiClass-clean episodes.',
      },
      {
        key: 'SEARCH_EPISODIC_LANE_TOPK',
        category: 'pipeline',
        defaultValue: '8',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Transcript quotes per synthesis prompt from the episodic lane — verbatim turns are token-heavy, keep the cap low.',
      },
      {
        key: 'SYNTHESIZE_SOURCE_EXCERPTS',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Provenance lane (road-to-90 A1): quote the verbatim source turns of the selected evidence facts (knowledge_fact.source.episodeIds → episode) in the synthesis prompt — restores the concrete detail a derivation summarized away. Same PII gate and degradation contract as the episodic lane.',
      },
      {
        key: 'SYNTHESIZE_SOURCE_EXCERPTS_CAP',
        category: 'pipeline',
        defaultValue: '16',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Episode quotes per synthesis prompt from the provenance lane; first-seen (≈ evidence relevance order) wins under the cap.',
      },
      {
        key: 'SEARCH_SEGMENT_LANE_ENABLED',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'L0 segment lane (memory-rebuild R1): retrieve verbatim multi-turn segments (episode_segment, built by POST /v1/admin/maintenance/segments) via dense+BM25 RRF as retrieval units in their own right, rendered as transcript excerpts in the synthesis prompt. PII-gated like the episodic lane.',
      },
      {
        key: 'SEARCH_SEGMENT_LANE_TOPK',
        category: 'pipeline',
        defaultValue: '5',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Segments per synthesis prompt from the segment lane — segments are multi-turn and token-heavy, keep the cap low.',
      },
      {
        key: 'SEARCH_SEGMENT_LANE_RERANK',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Precision-trim the fused segment pool with the listwise reranker (requires SEARCH_RERANKER_ENABLED) before the top-k cut.',
      },
      {
        key: 'AGENT_QA_TOOLS_V2',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Agent-QA V2 tool set (memory-rebuild R3): masked search_memory (facts already shown are never repeated — each call must surface new evidence), timeline (chronological topic scan for enumeration/counting), grep_episodes (literal transcript search), plus date-arithmetic loop prompt. Off = the original single-tool loop, byte-identical.',
      },
      {
        key: 'AGENT_QA_ROUTE_MODE',
        category: 'pipeline',
        defaultValue: null,
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          "Agent-QA routing (memory-rebuild R3b): 'escalate' answers one-shot (multi-hop search + synthesis) first and runs the ReAct loop ONLY when the one-shot answer is null, hedging, or citation-free — the loop replacing one-shot wholesale measured −4.6pp. Unset = pure loop.",
      },
      {
        key: 'RETRIEVAL_DERIVED_VERSION',
        category: 'search',
        defaultValue: null,
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Derived-namespace pin (substrate P3): read only facts stamped with this derivedVersion (e.g. wd-v2, written by POST /v1/admin/maintenance/derive). Unset = legacy namespace only (facts without a version). Switching the value switches the whole retrieval world atomically.',
      },
      {
        key: 'SYNTHESIZE_ANSWER_ROUTER_ENABLED',
        category: 'pipeline',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Typed Answer Dispatch T1 (docs/roadmap/typed-answer-dispatch-2026-07.md): lexical router recognizes temporal-distance questions and switches synthesis into compute-then-answer — each dated fact gets a precomputed [elapsed: N days ≈ W weeks ≈ M months] annotation vs asOf and the date anchor is forced. Fail-open: unrouted queries take the legacy path byte-identically. Genre-profile flag: OFF for LoCoMo-convention corpora (session-date golds), ON for true-date-arithmetic corpora (LongMemEval/BEAM).',
      },
      {
        key: 'BRAIN_TENANT_OVERRIDE_ENABLED',
        category: 'auth',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Allow an admin-scoped key to address another tenant via the X-Brain-Tenant header (slug-validated). Built for eval harnesses needing per-question tenant isolation (LongMemEval/BEAM: one haystack per tenant) without minting hundreds of keys. Never enable in multi-tenant prod without a policy review.',
      },
      {
        key: 'INGEST_EPISODE_ONLY',
        category: 'extractor',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Mention ingest captures the raw episode and returns before LLM extraction — the derived world is then built in batch by POST /v1/admin/maintenance/derive. LLM-free ingest for eval harnesses and bulk backfills; requires EPISODE_SUBSTRATE_ENABLED.',
      },
      {
        key: 'INGEST_CONTEXTUAL_FACT_EMBEDDING',
        category: 'embedder',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Contextual fact embedding: embed mention-extracted facts with a speaker+date context stamp so the vector matches context-referencing queries (Anthropic Contextual Retrieval, fact-level). Changes the embedding basis — requires re-ingest.',
      },
      {
        key: 'INGEST_EVENT_TIME_EXTRACTION',
        category: 'extractor',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          "Event-time extraction: when a mention clause carries a relative temporal expression (\"yesterday\", \"last year\", \"3 weeks ago\", RU \"вчера\"/\"три недели назад\"), resolve the occurrence date against the message time and use it for the fact's validFrom instead of the message time. Multilingual via chrono-node, dispatched by the clause's detected language (en/ru/fr/de/es/pt/…), English fallback; no LLM call. Unresolvable clauses fall back to message time. Requires re-ingest.",
      },
      // ── Dialogue memory mode ────────────────────────────────────────
      // All default-off and all requiring a re-ingest: they change what gets
      // WRITTEN, so toggling them only affects facts extracted afterwards.
      {
        key: 'EXTRACTOR_DIALOGUE_PROFILE',
        category: 'extractor',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Dialogue extraction profile: drop the closed CRM predicate vocabulary from the extraction call and let the model coin a SPECIFIC predicate per clause, keeping normalized (non-verbatim) values, attributing facts to the actor rather than the speaker, and enumerating lists. A closed label set as output contract is what drives the catch-all collapse ("conservative bias"); the vocabulary belongs downstream in canonicalization, not in the extractor. Measured +2.8pp on LoCoMo dev-5. Also bypasses the span-grounding drop (values are normalized by design) and skips the specificity-collapsing refinement passes. Requires re-ingest.',
      },
      {
        key: 'EXTRACTOR_ROUTING_ENABLED',
        category: 'extractor',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Facet routing (dialogue profile only): a turn containing a list (3+ items) or a proper name also gets a SPECIALIST extraction pass whose only contract is that one thing, unioned with the general pass. Strictly additive recall — the general pass still runs and the union deduplicates. The router is a local heuristic, not an LLM call. Costs one extra extraction call per detected facet. Requires re-ingest.',
      },
      {
        key: 'LIVE_SUBSCRIPTIONS_ENABLED',
        category: 'misc',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Realtime fact subscriptions (SSE at /v1/live/facts). A dedicated per-tenant connection OUTSIDE both pools holds a LIVE SELECT on knowledge_fact, with the 30-day changefeed as the gap-replay bridge on reconnect and the per-row ABAC/scope gate applied to every pushed event using the SUBSCRIBER\'s scopes. Single-pod prototype: multi-pod fan-out needs per-tenant leader election, not yet built. Off → no socket is opened and the endpoint answers 503.',
      },
      {
        key: 'INGEST_BATCH_EDGES',
        category: 'extractor',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          'Batched edge persistence: collapse the per-edge RELATE round-trips of a mention into TWO queries (one multi-statement existence check, then one multi-statement RELATE for only the missing edges); re-ingest with all edges present is a single round-trip. Same observable outcome as the per-edge loop (idempotent RELATE on UNIQUE(in,out,kind)); a concurrent-writer race falls back to the per-edge primitive. Read at boot.',
      },
      {
        key: 'INGEST_INLINE_RESOLUTION_HNSW',
        category: 'extractor',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          "Route the inline entity-resolution name-candidate scan through the native HNSW index (<|k,ef|>) instead of a per-ingest full cosine scan of every 'name' fact. Over-fetches (candidateK × INGEST_INLINE_RESOLUTION_HNSW_OVERFETCH, default 8, capped 1000) since KNN pre-filters before the name/type WHERE. Tenants without a built index fall back to the full scan (build via POST /v1/admin/maintenance/hnsw). CORRECTNESS-SENSITIVE — a missed approximate candidate creates a DUPLICATE entity; run the dedup recall eval and verify parity vs full scan before enabling. Only active when INGEST_INLINE_RESOLUTION_ENABLED is also on. Read at boot.",
      },
      {
        key: 'SEARCH_COMBINED_VECTOR_GRAPH',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          "Combined vector+graph retrieval: fold each fact's entity neighbourhood (->knowledge_edge->) into the vector KNN query as a co-equal projection, so candidate generation is ONE SurrealQL round-trip instead of a vector query plus a separate edge-expansion lookup (SurrealDB's native hybrid-retrieval strength). Edge-expansion reuses the prefetched neighbours and only queries uncovered seeds. Off = byte-identical (empty projection + legacy lookup). Read at boot.",
      },
      {
        key: 'SEARCH_HIGHLIGHT_ENABLED',
        category: 'search',
        defaultValue: '0',
        runtimeMutable: false,
        isBooleanFlag: true,
        description:
          "BM25 match snippets: project search::highlight('<em>','</em>',1) from the lexical leg (the FULLTEXT indexes already carry HIGHLIGHTS but it was never queried) and surface a `highlight` field on lexically-matched facts. Off = no highlight field (byte-identical payload). Read at boot.",
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
      // ── Marketplace billing (paid packs, migration 0066) ─────
      {
        key: 'DOMAIN_PACK_BILLING_ENABLED',
        category: 'billing',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description:
          'Paid-pack marketplace integration with the central billing service. Off (default) = self-hosted posture: paid metadata is ignored, every pack installs free.',
      },
      {
        key: 'BILLING_SERVICE_URL',
        category: 'billing',
        defaultValue: null,
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Base URL of the billing service (e.g. https://billing.inite.ai). Required while the billing flag is on — validated at boot.',
      },
      {
        key: 'BILLING_SERVICE_API_KEY',
        category: 'billing',
        defaultValue: null,
        runtimeMutable: true,
        isBooleanFlag: false,
        secret: true,
        description:
          'Service API key (x-api-key header) identifying brain as a registered Service in the billing admin.',
      },
      {
        key: 'BILLING_TIMEOUT_MS',
        category: 'billing',
        defaultValue: '5000',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'Per-request budget for billing HTTP calls; reads (entitlements, product list) get one retry on timeout/network/5xx.',
      },
      {
        key: 'BILLING_ENTITLEMENT_CACHE_TTL_MS',
        category: 'billing',
        defaultValue: '60000',
        runtimeMutable: true,
        isBooleanFlag: false,
        description:
          'In-memory TTL for per-company entitlement lookups. Never served stale: expired cache + billing down fails paid installs CLOSED (503).',
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
