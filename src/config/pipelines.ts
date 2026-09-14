/**
 * PIPELINES — the assembled conveyor, declared in code.
 *
 * WHY THIS EXISTS. The engine has ~206 boolean lanes and the assembly
 * that actually ships was declared nowhere: 152 of them are switched on
 * as 152 loose `KEY=1` lines inside a GitHub Actions deploy step, beside
 * 25 tuning values and 49 pieces of infrastructure config. Three things
 * follow from that, and all three are bad:
 *
 *  - THE CONVEYOR IS NOT A THING. "Which lanes make up the system we
 *    ship" has no answer in the codebase; you grep a YAML for it.
 *  - EVERY MEASUREMENT IS A BENCH TEST. Flipping one lane against a
 *    baseline where the rest are off measures a component in isolation,
 *    and lanes interact — so the number does not describe that lane's
 *    contribution to the assembled system. It is also hopeless
 *    statistically: single lanes measured at n=3 tenants land at
 *    p = 0.27 and p = 0.42 and say nothing in either direction.
 *  - NOTHING CAN BE THROWN AWAY. A lane in no pipeline is dead weight,
 *    but with the assembly living in a YAML the question cannot be asked
 *    mechanically. Now it can, and the gate in pipelines.unit-spec.ts
 *    asks it: every catalog lane is either in a pipeline or named in
 *    NOT_IN_ANY_PIPELINE with a reason.
 *
 * RESOLUTION ORDER keeps the operator in charge — an explicit env key
 * still beats everything, so a kill-switch still kills:
 *
 *   explicit env key  >  BRAIN_PIPELINE's settings  >  code default
 *
 * `assistant-chat` is a TRANSCRIPTION, not a redesign: generated from
 * the deploy workflow, so selecting it changes nothing. That is the
 * point — the assembly becomes nameable before it becomes negotiable.
 */

export type PipelineId = 'assistant-chat' | 'multilingual';

export interface Pipeline {
  id: PipelineId;
  /** What this conveyor is for, in one line. */
  description: string;
  /** Every setting the pipeline supplies. Absent key = code default. */
  settings: Readonly<Record<string, string>>;
}

/**
 * The shipped conveyor. Transcribed from
 * .github/workflows/deploy-brain.yml as of 2026-09-14 — 152 lanes and
 * 25 tuning values, generated rather than retyped.
 */
const ASSISTANT_CHAT_SETTINGS: Readonly<Record<string, string>> = {
  ABAC_DB_FENCE_ENABLED: '1',
  ABAC_ENABLED: '1',
  AGENT_QA_TOOLS_V2: '1',
  AUDIT_CHANGEFEED_ENABLED: '1',
  BELIEFS_API_ENABLED: '1',
  BELIEFS_FACT_DAMPING: '1',
  BELIEFS_LANE_DATE_DISAMBIGUATION: '1',
  BELIEFS_SERVING_LANE: '1',
  COMPACTION_PROMOTION_CONFLICT_GUARD: '1',
  COMPACTION_PROMOTION_ENABLED: '1',
  COMPACTION_SUMMARIES: '1',
  CONFLICT_DIRECT_FACT_SLOT: '1',
  CONFLICT_MENTION_FACT_SLOT: '1',
  CONFLICT_SLOT_CANONICALIZATION: '1',
  CONFLICT_TEMPORAL_TIEBREAKER: '1',
  DERIVER_ASSISTANT_CONTENT: '1',
  DERIVER_COMPLETION_PASS: '1',
  DERIVER_COMPOSE_PASS: '1',
  DERIVER_DATE_RESOLVE: '1',
  DERIVER_DIGEST: '1',
  DERIVER_MENTION_STAMP: '1',
  DERIVER_SALIENCE_STAMP: '1',
  DERIVER_SCENE_TRACE: '1',
  DERIVER_SLOT_SEMANTICS: '1',
  DERIVER_SPANS: '1',
  DERIVER_TURN_HEADERS: '1',
  DERIVER_TYPED_ATOMS: '1',
  DOCUMENT_INGEST_ENABLED: '1',
  DOCUMENT_MULTI_INDEXER_ENABLED: '1',
  DOMAIN_PACK_BILLING_ENABLED: '1',
  DREAMS_COMMUNITIES_ENABLED: '1',
  DREAMS_CORROBORATE_ENABLED: '1',
  DREAMS_DEDUP_ENABLED: '1',
  DREAMS_ENABLED: '1',
  DREAMS_LLM_SUMMARY_ENABLED: '1',
  DREAMS_RESOLVE_ENABLED: '1',
  DREAMS_RUN_SUMMARIZE: '1',
  EPISODES_API_ENABLED: '1',
  EPISODE_SUBSCRIPTIONS_ENABLED: '1',
  EPISODE_SUBSTRATE_ENABLED: '1',
  EVIDENCE_FAIL_CLOSED_CAPTURE: '1',
  EVIDENCE_FRAGMENT_CITATIONS: '1',
  EVIDENCE_GROUNDING_STAMP: '1',
  EVIDENCE_INGEST_ENABLED: '1',
  EVIDENCE_PROCESSOR_BROKER: '1',
  EVIDENCE_QUARANTINE: '1',
  EVIDENCE_RAW_READ_ENABLED: '1',
  EVIDENCE_SUBSTRATE_ENABLED: '1',
  EVIDENCE_UNGROUNDED_EXCLUDE: '1',
  EVIDENCE_UNGROUNDED_SERVING_GATE: '1',
  EXTRACTION_OBJECT_NORMALIZE: '1',
  EXTRACTOR_LITERAL_HARVEST: '1',
  EXTRACTOR_ROUTING_ENABLED: '1',
  EXTRACTOR_STATE_VERB_HARVEST: '1',
  EXTRACTOR_TRANSITION_CLASSIFIER: '1',
  FACTS_API_ENABLED: '1',
  FOVEA_ADAPTIVE_ABSTAIN: '1',
  FOVEA_ADAPTIVE_L3: '1',
  FOVEA_ATTENTION_HINTS: '1',
  FOVEA_EVIDENCE_CAPABILITY: '1',
  FOVEA_FOCUS_CAPTURE: '1',
  FOVEA_FRAGMENT_ZOOM: '1',
  FOVEA_L3_EPISODE_CITATIONS: '1',
  FOVEA_LENS_SUPPRESS: '1',
  FOVEA_PLAUSIBILITY_CHECK: '1',
  FOVEA_REQUIRE_CITATIONS: '1',
  INGEST_ARTICLE_NORMALIZATION: '1',
  INGEST_BATCH_EDGES: '1',
  INGEST_CONTEXTUAL_FACT_EMBEDDING: '1',
  INGEST_EVENT_TIME_EXTRACTION: '1',
  INGEST_INLINE_RESOLUTION_HNSW: '1',
  INGEST_SANITIZE_UNICODE: '1',
  LIVE_SUBSCRIPTIONS_ENABLED: '1',
  MCP_PACK_EXTERNAL_TOOLS_ENABLED: '1',
  MCP_PACK_TOOLS_ENABLED: '1',
  MULTILINGUAL_LANG_FILTER_CONFIDENCE_GATE: '1',
  MULTI_HOP_EDGE_EXPANSION_ENABLED: '1',
  OUTCOME_DECISION_CAPTURE: '1',
  OUTCOME_RETRIEVED_EVENTS: '1',
  OUTCOME_TELEMETRY_ENABLED: '1',
  OUTCOME_TX_WRITES: '1',
  PACK_MEMORY_PROJECTIONS_ENABLED: '1',
  POLICY_META_UNION_ENABLED: '1',
  PRIVACY_COMPOSER_USER_SCOPE: '1',
  PRIVACY_SEGMENT_USER_FENCE: '1',
  PROJECTIONS_API_ENABLED: '1',
  PROVENANCE_EPISODE_NEIGHBOURS: '1',
  PROVENANCE_RECURSIVE_CLOSURE: '1',
  PROVENANCE_SUMMARY_EPISODE_STAMP: '1',
  PROVENANCE_SUPPORT_EDGES: '1',
  PROVENANCE_SUPPORT_GRAPH_READ: '1',
  READ_SURFACE_USER_SCOPE: '1',
  RETRIEVAL_ANSWER_CONDITIONING: '1',
  RETRIEVAL_ASSISTANT_LANE: '1',
  RETRIEVAL_DATE_MATH: '1',
  RETRIEVAL_DIGEST_EVIDENCE: '1',
  RETRIEVAL_ENTITY_EXPANSION: '1',
  RETRIEVAL_ENUM_STRICT: '1',
  RETRIEVAL_FACTS_AS_KEYS: '1',
  RETRIEVAL_FRAGMENT_LANE: '1',
  RETRIEVAL_L3_DIRECT_ANCHOR: '1',
  RETRIEVAL_L3_ESCALATION: '1',
  RETRIEVAL_L3_SEGMENT_ANCHOR: '1',
  RETRIEVAL_L3_TEMPORAL_ANCHOR: '1',
  RETRIEVAL_MENTION_DATES: '1',
  RETRIEVAL_NOISE_FILTER: '1',
  RETRIEVAL_ORDERING_FRAME: '1',
  RETRIEVAL_RAW_WINDOW: '1',
  RETRIEVAL_SALIENCE_SCORING: '1',
  RETRIEVAL_SCENE_TRACES: '1',
  RETRIEVAL_SEARCH_LOOP: '1',
  RETRIEVAL_TENANT_DECAY: '1',
  RETRIEVAL_TIME_FILTER: '1',
  RETRIEVAL_UPDATE_STORY: '1',
  RETRIEVAL_VERIFIED_USE_DECAY: '1',
  RETRIEVAL_VERIFIED_USE_RANKING: '1',
  RETRIEVAL_VERIFIER_TOPIC_COVERAGE: '1',
  SCENES_BELIEF_FIELD_FOLD: '1',
  SCENES_BELIEF_LLM_SYNTHESIS: '1',
  SCENES_BELIEF_NEGATION_DELTAS: '1',
  SCENES_BELIEF_PROMOTION: '1',
  SCENES_EVIDENCE_LINKS: '1',
  SCENES_FACT_BACKLINK: '1',
  SCENES_LLM_ENRICHMENT: '1',
  SCENES_SEGMENTATION_ENABLED: '1',
  SCENES_TOPIC_BOUNDARY: '1',
  SCENES_VERSION_FINGERPRINT: '1',
  SCOPE_TAGS_ENABLED: '1',
  SEARCH_COMBINED_VECTOR_GRAPH: '1',
  SEARCH_EPISODIC_LANE_ENABLED: '1',
  SEARCH_FACT_RERANK: '1',
  SEARCH_HIGHLIGHT_ENABLED: '1',
  SEARCH_HNSW_ENABLED: '1',
  SEARCH_SEGMENT_LANE_ENABLED: '1',
  SEARCH_SEGMENT_LANE_RERANK: '1',
  SEARCH_USAGE_DECAY_ENABLED: '1',
  SEARCH_USAGE_RANKING_ENABLED: '1',
  SEARCH_USAGE_RECORDING_ENABLED: '1',
  SOURCE_META_STRICT: '1',
  STATS_VIEWS_ENABLED: '1',
  STRATEGY_DISTILL_CRON_ENABLED: '1',
  STRATEGY_MEMORY_ENABLED: '1',
  STRATEGY_RETRIEVAL_ENABLED: '1',
  STRATEGY_TRAJECTORIES_ENABLED: '1',
  SYNTHESIZE_ANSWER_CACHE: '1',
  SYNTHESIZE_ANSWER_ROUTER_ENABLED: '1',
  SYNTHESIZE_INSTRUCTION_LANE: '1',
  SYNTHESIZE_LANE_WIDE_PROBE: '1',
  SYNTHESIZE_SOURCE_EXCERPTS: '1',
  TOOL_OBSERVATIONS_ENABLED: '1',
  TOOL_OBSERVATION_CONTENT: '1',
  USER_PROFILE_API_ENABLED: '1',
  BILLING_SERVICE_API_KEY: '${BRAIN_BILLING_API_KEY}',
  BILLING_SERVICE_URL: 'https://billing.inite.ai',
  CHAT_ROUTE_CACHE_SIZE: '2000',
  CHAT_ROUTE_HINT_MAX: '3',
  CHAT_ROUTE_HINT_SIMILARITY: '0.4',
  CHAT_ROUTE_INTENT_CONFIDENCE_FLOOR: '0.85',
  CHAT_ROUTE_NLI_ASK_THRESHOLD: '0.6',
  EMBEDDER_PROVIDER: 'bge-m3',
  EXTRACTOR_CACHE_SIZE: '500',
  EXTRACTOR_LOCAL_NER_MIN_SCORE: '0.7',
  EXTRACTOR_LOCAL_PREDICATE_THRESHOLD: '0.45',
  OPENAI_API_KEY: '${BRAIN_OPENAI_API_KEY}',
  OPENAI_CHAT_MODEL: 'gpt-4o-mini-2024-07-18',
  OPENAI_CONCURRENCY: '8',
  OPENAI_MAX_RETRIES: '3',
  OPENAI_TIMEOUT_MS: '30000',
  RETRIEVAL_GENRE: 'assistant_chat',
  RETRIEVAL_VERBATIM_EVIDENCE: 'shape_conditioned',
  SEARCH_EDGE_EXPANSION_ALPHA: '0.4',
  SEARCH_EDGE_EXPANSION_MAX_NEIGHBOURS: '5',
  SEARCH_EDGE_EXPANSION_TOP_SEEDS: '3',
  SEARCH_PPR_AUTO_THRESHOLD: '25',
  SEARCH_USAGE_BETA: '0.1',
  SEARCH_VERIFIED_USE_BETA: '0.1',
  TRUST_PROXY: '1',

  EXTRACTOR_LOCAL_NER_ENABLED: 'true',
  EXTRACTOR_SKIP_LLM_ENABLED: 'true',

  // The deploy writes these five as `=true` rather than `=1`;
  // envFlagEnabled accepts both, so they are live lanes. Transcribed at
  // the deploy's own spelling so the two sides compare literally.

  // ── Shipped by CODE DEFAULT, not by the deploy ──────────────────────
  // The other half of the split this file exists to end: these lanes run
  // in production because their code default is on, so the deploy never
  // mentions them and the YAML alone does not describe what ships.
  // Written out here at the value they already resolve to, which changes
  // nothing and makes the conveyor complete.
  CALIBRATION_USE_GOLD_SET: '1',
  CAPABILITY_PROBE_ENABLED: '1',
  CHAT_ROUTE_CACHE_ENABLED: 'true',
  CHAT_ROUTE_NLI_ENABLED: 'true',
  CHAT_ROUTE_NLI_WORKER: '1',
  EMBEDDING_SPACE_STRICT: '1',
  EVIDENCE_GRANTS_API_ENABLED: '1',
  EXTRACTOR_CACHE_ENABLED: 'true',
  EXTRACTOR_LOCAL_NER_WORKER: '1',
  INDEXER_OPERATOR_VIEW_ENABLED: '1',
  INDEXER_WEBHOOK_PUSH_ENABLED: '1',
  JOB_RUN_PERSIST: '1',
  MCP_PACK_QUERY_TOOLS_ENABLED: '1',
  PACK_SEED_INGEST_ENABLED: '1',
  SEARCH_TOKEN_COUNT_OFFLOAD: '1',
  SYNTHESIZE_DATE_CONTEXT: '1',
};

/**
 * The multilingual conveyor: the shipped assembly PLUS the eleven
 * MULTILINGUAL_* lanes, which have never run anywhere.
 *
 * They are one pipeline rather than eleven flags on purpose. The
 * roadmap specifies them as a CHAIN — attribution feeds the confidence
 * gates, which feed the soft filter and the lane router, which feed the
 * answer guard — so a lane flipped alone is measured against a system
 * that cannot use what it produces. The Tier-0 matrix
 * (`npm run eval:multilingual`) scores this assembly against
 * `assistant-chat` as two conveyors; a link that earns nothing inside
 * the assembled chain is a link to cut, not a flag to keep flipping.
 */
const MULTILINGUAL_SETTINGS: Readonly<Record<string, string>> = {
  ...ASSISTANT_CHAT_SETTINGS,
  MULTILINGUAL_ANSWER_GUARD: '1',
  MULTILINGUAL_CALIBRATION: '1',
  MULTILINGUAL_CJK_SEGMENTATION: '1',
  MULTILINGUAL_CONFLICT: '1',
  MULTILINGUAL_ENTITY_REVERSIBLE: '1',
  MULTILINGUAL_LANE_ROUTING: '1',
  MULTILINGUAL_LANG_ATTRIBUTION: '1',
  MULTILINGUAL_LANG_FILTER_CONFIDENCE_GATE: '1',
  MULTILINGUAL_LANG_STAMP_CONFIDENCE_GATE: '1',
  MULTILINGUAL_SOFT_LANG_FILTER: '1',
  MULTILINGUAL_TEMPORAL: '1',
};

export const PIPELINES: Readonly<Record<PipelineId, Pipeline>> = {
  'assistant-chat': {
    id: 'assistant-chat',
    description: 'The shipped conveyor: assistant-chat retrieval over a per-tenant graph.',
    settings: ASSISTANT_CHAT_SETTINGS,
  },
  multilingual: {
    id: 'multilingual',
    description: 'assistant-chat plus the language-attribution chain, for non-English tenants.',
    settings: MULTILINGUAL_SETTINGS,
  },
};

/**
 * Catalog lanes that belong to NO pipeline, each with its reason.
 *
 * Two kinds only. An OPERATIONAL toggle must stay off in a shipped
 * conveyor and exists for an operator or an eval stand — break-glass,
 * debug, migration tooling. A CUT CANDIDATE was built, never deployed
 * and never measured; it is listed here so the set is short, visible and
 * arguable instead of spread across 206 catalog entries.
 */
export const NOT_IN_ANY_PIPELINE: Readonly<Record<string, string>> = {
  ABAC_FORCE_REPORT_ONLY: 'operational: break-glass, disables enforcement',
  BRAIN_TENANT_OVERRIDE_ENABLED: 'operational: eval/debug tenant override',
  DEBUG_TRACE_PERSIST: 'operational: debug trace capture',
  INGEST_EPISODE_ONLY: 'operational: eval toggle',
  MCP_PACK_TOOLS_ALLOW_HTTP: 'operational: relaxes a fence for local dev',
  EMBEDDING_SPACE_ACTIVE: 'operational: embedding-space migration tooling',
  EMBEDDING_SPACE_DUAL_WRITE: 'operational: embedding-space migration tooling',
  EMBEDDING_SPACE_TRACKING: 'operational: embedding-space migration tooling',
  EVIDENCE_S3_FORCE_PATH_STYLE: 'operational: deployment-shape config (MinIO vs S3)',
  EVIDENCE_BLOB_UPLOAD_ENABLED: 'cut candidate: built, never deployed, never measured',
  EVIDENCE_FRAGMENT_EMBEDDINGS: 'cut candidate: built, never deployed, never measured',
  EXTRACTOR_DIALOGUE_PROFILE: 'cut candidate: built, never deployed, never measured',
  INGEST_CODE_ALIAS_RESOLUTION: 'cut candidate: built, never deployed, never measured',
  INGEST_CONFUSABLES_CHECK: 'cut candidate: built, never deployed, never measured',
  INGEST_PREDICATE_INDEX_TEXT: 'cut candidate: built, never deployed, never measured',
  PACK_SOURCE_VERSION_STALENESS: 'cut candidate: built, never deployed, never measured',
  RETRIEVAL_SCENE_LANE: 'cut candidate: built, never deployed, never measured',
  SCENES_ENTITY_LINKS: 'scene plane: a conveyor of its own, not yet assembled into one',
  SCENES_GIST_EMBEDDING: 'scene plane: a conveyor of its own, not yet assembled into one',
  SCENES_PACK_DELTA_PROMOTION: 'scene plane: a conveyor of its own, not yet assembled into one',
  SCENES_PREDICTION_BASELINE: 'scene plane: a conveyor of its own, not yet assembled into one',
  SCENES_SCHEDULED_MAINTENANCE: 'scene plane: a conveyor of its own, not yet assembled into one',
  SCENES_VALUE_GATE_ENABLED: 'scene plane: a conveyor of its own, not yet assembled into one',
  CALIBRATION_NIGHTLY_REFIT: 'cut candidate: built, never deployed, never measured',
  HNSW_PROVISION_ENABLED: 'cut candidate: built, never deployed, never measured',
  SEARCH_PPR_ENABLED: 'live via SEARCH_PPR_AUTO_THRESHOLD, never via this key',
};

/** The pipeline this process runs, or undefined for code defaults only. */
export function resolvePipeline(env: NodeJS.ProcessEnv = process.env): Pipeline | undefined {
  const id = (env.BRAIN_PIPELINE ?? '').trim();
  return id in PIPELINES ? PIPELINES[id as PipelineId] : undefined;
}

/**
 * The value for one key under the resolved pipeline: an explicit env key
 * wins, then the pipeline, then undefined — the caller's code default.
 */
export function pipelineValue(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env[key];
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  return resolvePipeline(env)?.settings[key];
}
