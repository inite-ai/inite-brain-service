import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ConfigCategory =
  | 'pipeline'
  | 'extractor'
  | 'embedder'
  | 'dreams'
  | 'compaction'
  | 'audit'
  | 'router'
  | 'search'
  | 'multihop'
  | 'calibration'
  | 'conflict'
  | 'cost'
  | 'throttle'
  | 'jobs'
  | 'auth'
  | 'misc';

export interface ConfigEntry {
  key: string;
  category: ConfigCategory;
  /** Stringified current value (or '∅' when unset and no default applies). */
  currentValue: string;
  defaultValue: string | null;
  /** Whether changing the value at runtime takes effect without restart. */
  runtimeMutable: boolean;
  /** Whether the knob is a true boolean ("0"|"1" / "true"|"false") so the UI can render a toggle. */
  isBooleanFlag: boolean;
  /** Hint for the operator. Tiny, not a full doc. */
  description?: string;
  /** Whether the current value exposes a secret (API key, etc) — masked in the UI. */
  secret?: boolean;
}

/**
 * Catalogue of operator-visible env knobs. Hard-coded list so the
 * UI gets curated descriptions + correct restart-required flags;
 * the alternative (reading process.env) would surface arbitrary
 * platform variables that aren't ours.
 *
 * NEW knobs: add an entry below. The `runtimeMutable` flag controls
 * whether the admin UI offers a toggle for booleans. Mutability is
 * implemented in FeatureFlagOverrideService (env override map read on
 * each config get).
 */
@Injectable()
export class ConfigInspectorService {
  constructor(private readonly config: ConfigService) {}

  list(): ConfigEntry[] {
    return this.catalogue().map((spec) => {
      const raw = this.config.get<string>(spec.key);
      const current = raw ?? '';
      return {
        key: spec.key,
        category: spec.category,
        currentValue: spec.secret
          ? current
            ? '••• set'
            : '∅'
          : current === ''
            ? spec.defaultValue ?? '∅'
            : current,
        defaultValue: spec.defaultValue ?? null,
        runtimeMutable: spec.runtimeMutable === true,
        isBooleanFlag: spec.isBooleanFlag === true,
        description: spec.description,
        secret: spec.secret,
      };
    });
  }

  /**
   * Compact list of (key, group). Surfaced for the cmd-K palette or
   * external integrations that just need the schema.
   */
  schema(): Array<{ key: string; category: ConfigCategory }> {
    return this.catalogue().map((s) => ({
      key: s.key,
      category: s.category,
    }));
  }

  // TODO: catalogue is a declarative list of every env-flag + its
  // documentation. The 473-line method is intentional — these aren't
  // many small functions, it's ONE big literal. Splitting would
  // sprinkle 30+ getters across the file for no readability win.
  // Right refactor target is moving the entries into a JSON
  // resource file, then this method becomes a `parse + project`.
  // Tracked separately.
  // eslint-disable-next-line max-lines-per-function
  private catalogue(): Array<
    Omit<ConfigEntry, 'currentValue'> & {
      defaultValue: string | null;
    }
  > {
    return [
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
        defaultValue: '0.6',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'EXTRACTOR_LOCAL_NER_MODEL',
        category: 'extractor',
        defaultValue: 'Xenova/bert-base-NER',
        runtimeMutable: false,
        isBooleanFlag: false,
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
        runtimeMutable: true,
        isBooleanFlag: true,
        description: 'Master switch for the 04:00 UTC cron.',
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
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
      },
      {
        key: 'CHAT_ROUTE_NLI_ASK_THRESHOLD',
        category: 'router',
        defaultValue: '0.6',
        runtimeMutable: false,
        isBooleanFlag: false,
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
        defaultValue: '0.2',
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
        defaultValue: '0.3',
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
        defaultValue: '0.2',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CONFLICT_MARGIN_SUPERSEDE',
        category: 'conflict',
        defaultValue: '0.1',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
      {
        key: 'CONFLICT_REJECT_THRESHOLD',
        category: 'conflict',
        defaultValue: '0.4',
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
          'Dedicated per-pack indexer runs + relevance router + async fan-out. Off = only the generalist union pass runs.',
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
        key: 'DREAMS_COMMUNITIES_ENABLED',
        category: 'dreams',
        defaultValue: '0',
        runtimeMutable: true,
        isBooleanFlag: true,
        description: 'Build + persist entity-community summaries during dreams.',
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
    ];
  }
}
