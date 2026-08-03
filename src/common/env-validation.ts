import { Logger } from '@nestjs/common';
import { isProcessRole, normalizeProcessRole } from './process-role';
import { parseDisabledLanes } from '../synthesize/lanes-disabled';

const log = new Logger('EnvValidation');

// The placeholder password baked into migration 0005's `DEFINE USER
// brain_caller`. It is public (lives in the repo), so deploying with it
// unchanged leaves the scoped account on a known credential.
const SHIPPED_SCOPED_PASS_DEFAULT =
  'brain-caller-password-must-be-overridden-via-env';

/**
 * Validate required environment variables at boot. Fails fast with a
 * single multi-line error rather than dribbling out 500s once requests
 * start arriving.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Required ──────────────────────────────────────────────────────
  required({ env, name: 'SURREALDB_URL', errors, pattern: /^(ws|wss|http|https):\/\// });
  required({ env, name: 'SURREALDB_USERNAME', errors });
  required({ env, name: 'SURREALDB_PASSWORD', errors });
  required({ env, name: 'OPENAI_API_KEY', errors, pattern: /^sk-/ });

  // ── Auth ─────────────────────────────────────────────────────────
  // BRAIN_API_KEYS is required, but [] is acceptable in dev (no callers).
  const rawKeys = env.BRAIN_API_KEYS ?? '[]';
  try {
    const parsed = JSON.parse(rawKeys);
    if (!Array.isArray(parsed)) {
      errors.push('BRAIN_API_KEYS must be a JSON array');
    } else {
      for (const [i, k] of parsed.entries()) {
        if (!k.keyHash || typeof k.keyHash !== 'string') {
          errors.push(`BRAIN_API_KEYS[${i}].keyHash is missing`);
        }
        if (!k.companyId || typeof k.companyId !== 'string') {
          errors.push(`BRAIN_API_KEYS[${i}].companyId is missing`);
        }
        if (!Array.isArray(k.scopes) || k.scopes.length === 0) {
          errors.push(`BRAIN_API_KEYS[${i}].scopes must be a non-empty array`);
        }
      }
      if (parsed.length === 0 && env.NODE_ENV === 'production') {
        warnings.push(
          'BRAIN_API_KEYS is empty in production — no caller can authenticate',
        );
      }
    }
  } catch (e) {
    errors.push(`BRAIN_API_KEYS is not valid JSON: ${(e as Error).message}`);
  }

  // ── HMAC for forget tombstones ────────────────────────────────────
  if (!env.FORGET_HMAC_KEY) {
    if (env.NODE_ENV === 'production') {
      errors.push(
        'FORGET_HMAC_KEY must be set in production — using the default lets anyone forge tombstone hashes',
      );
    } else {
      warnings.push(
        'FORGET_HMAC_KEY uses an insecure default. Set it before deploying.',
      );
    }
  } else if (env.FORGET_HMAC_KEY.length < 32) {
    warnings.push('FORGET_HMAC_KEY is shorter than 32 chars — recommended ≥ 32');
  }

  // ── Production-only guards (scoped pool + test-only kill switches) ─
  validateProductionGuards(env, errors, warnings);

  // ── Process role (api / worker split) ─────────────────────────────
  validateProcessRole(env, errors);

  // ── Embedding dimensions ──────────────────────────────────────────
  const dims = env.OPENAI_EMBEDDING_DIMENSIONS;
  if (dims && (!/^\d+$/.test(dims) || parseInt(dims, 10) < 8)) {
    errors.push('OPENAI_EMBEDDING_DIMENSIONS must be an integer ≥ 8');
  }

  // ── Pool size ─────────────────────────────────────────────────────
  const pool = env.SURREALDB_POOL_SIZE;
  if (pool && (!/^\d+$/.test(pool) || parseInt(pool, 10) < 1)) {
    errors.push('SURREALDB_POOL_SIZE must be a positive integer');
  }

  // ── OpenAI resilience knobs ───────────────────────────────────────
  positiveInt(env, 'OPENAI_TIMEOUT_MS', errors);
  positiveInt(env, 'OPENAI_MAX_RETRIES', errors);
  positiveInt(env, 'OPENAI_CONCURRENCY', errors);
  positiveInt(env, 'EMBEDDING_CACHE_SIZE', errors);

  // ── Local NER worker (extractor pre-pass) ─────────────────────────
  positiveInt(env, 'EXTRACTOR_LOCAL_NER_TIMEOUT_MS', errors);

  // ── Throttling ────────────────────────────────────────────────────
  positiveInt(env, 'THROTTLE_TTL_MS', errors);
  positiveInt(env, 'THROTTLE_LIMIT', errors);
  // The "expensive" tier (search/synthesize) has its own knobs read in
  // app.module; validate them too so a typo isn't silently parseInt→NaN.
  positiveInt(env, 'THROTTLE_EXPENSIVE_TTL_MS', errors);
  positiveInt(env, 'THROTTLE_EXPENSIVE_LIMIT', errors);
  positiveInt(env, 'COMPACTION_HOT_RETENTION_DAYS', errors);

  // ── Body size cap (main.ts useBodyParser) ─────────────────────────
  validateBodySize(env, errors);

  // ── Pack supply-chain knobs ───────────────────────────────────────
  validatePackTrustEnv(env, errors);

  // ── Registry mirroring (pull-only) ────────────────────────────────
  validateRegistryMirrorEnv(env, errors);

  // ── Marketplace billing (paid packs) ──────────────────────────────
  validateBillingEnv(env, errors);

  // ── fact_trust ranking knobs (source-reputation Phase 5) ──────────
  nonNegativeFloat(env, 'SEARCH_TRUST_BETA', errors);
  nonNegativeFloat(env, 'SEARCH_CORROBORATION_GAMMA', errors);
  nonNegativeFloat(env, 'SEARCH_AUTHORITY_DELTA', errors);
  nonNegativeFloat(env, 'SYNTHESIZE_MIN_FACT_TRUST', errors);

  // ── Retrieval fact-shaping (chatter demotion + per-entity window) ──
  // Penalty is read with a (0,1] clamp; nonNegativeFloat only guards the
  // "is a number" contract here (≥1 is accepted and means "no penalty").
  nonNegativeFloat(env, 'SEARCH_CHATTER_PENALTY', errors);
  positiveInt(env, 'SEARCH_FACTS_PER_ENTITY', errors);
  positiveInt(env, 'SEARCH_BACKFILL_PER_PREDICATE', errors);

  // ── Occlusion ranking (front-to-back fact selection, flag-gated) ───
  // Threshold is read with a (0,1] clamp; nonNegativeFloat only guards
  // the "is a number" contract. DATE_GUARD_DAYS: 0 = guard disabled.
  nonNegativeFloat(env, 'SEARCH_OCCLUSION_THRESHOLD', errors);
  positiveInt(env, 'SEARCH_OCCLUSION_WINDOW', errors);
  nonNegativeInt(env, 'SEARCH_OCCLUSION_DATE_GUARD_DAYS', errors);

  // ── Phase A read-path (typed-memory roadmap 2026-07) ───────────────
  positiveInt(env, 'SEARCH_FACT_CENTRIC_BUDGET', errors);
  positiveInt(env, 'SYNTHESIZE_EXTRA_EVIDENCE_CAP', errors);
  positiveInt(env, 'SEARCH_EPISODIC_LANE_TOPK', errors);
  positiveInt(env, 'SYNTHESIZE_SOURCE_EXCERPTS_CAP', errors);
  positiveInt(env, 'SEARCH_SEGMENT_LANE_TOPK', errors);

  // ── Read-side query expansion ──────────────────────────────────────
  positiveInt(env, 'SEARCH_QUERY_EXPANSION_N', errors);
  positiveInt(env, 'SYNTHESIZE_WIDE_PROBE_LIMIT', errors);

  // ── Agent-in-loop QA ───────────────────────────────────────────────
  positiveInt(env, 'AGENT_QA_MAX_ROUNDS', errors);
  positiveInt(env, 'AGENT_QA_SEARCH_LIMIT', errors);
  positiveInt(env, 'AGENT_QA_MAX_FACTS_PER_ROUND', errors);

  // ── Episodic→semantic promotion (compaction leg) ───────────────────
  positiveInt(env, 'COMPACTION_PROMOTION_AGE_DAYS', errors);
  positiveInt(env, 'COMPACTION_PROMOTION_MIN_GROUP', errors);
  positiveInt(env, 'COMPACTION_PROMOTION_MAX_GROUPS', errors);

  // ── HNSW vector leg ────────────────────────────────────────────────
  positiveInt(env, 'SEARCH_HNSW_EF', errors);
  positiveInt(env, 'SEARCH_HNSW_OVERFETCH', errors);

  // ── HNSW on the inline entity-resolution name-candidate scan ───────
  positiveInt(env, 'INGEST_INLINE_RESOLUTION_HNSW_EF', errors);
  positiveInt(env, 'INGEST_INLINE_RESOLUTION_HNSW_OVERFETCH', errors);

  // ── Communities (dreams sub-op) ────────────────────────────────────
  // 0 is meaningful (= never offload label propagation to the worker
  // pool), so this one is non-negative rather than positive.
  nonNegativeInt(env, 'COMMUNITIES_LP_OFFLOAD_MIN_EDGES', errors);

  // ── tokenBudget shaping offload (default ON) ───────────────────────
  positiveInt(env, 'SEARCH_TOKEN_OFFLOAD_MIN_HITS', errors);

  // ── Edge expansion (default-ON retrieval stage) ────────────────────
  // Bad values silently fell back to defaults; the numeric knobs are now
  // boot-validated like the rest of the search stack.
  positiveInt(env, 'SEARCH_EDGE_EXPANSION_TOP_SEEDS', errors);
  positiveInt(env, 'SEARCH_EDGE_EXPANSION_MAX_NEIGHBOURS', errors);
  nonNegativeFloat(env, 'SEARCH_EDGE_EXPANSION_ALPHA', errors);

  // ── ABAC policy knobs ──────────────────────────────────────────────
validateAbacEnv(env, errors);

  // ── Document ingest knobs (Source → Indexer → Candidates → Brain) ──
  positiveInt(env, 'DOC_MAX_CHARS', errors);
  positiveInt(env, 'DOC_CHUNK_TARGET_CHARS', errors);
  positiveInt(env, 'CANDIDATE_RETENTION_DAYS', errors);
  positiveInt(env, 'CANDIDATE_PENDING_TTL_DAYS', errors);
  positiveInt(env, 'REINDEX_MAX_DOCS_PER_RUN', errors);
  positiveInt(env, 'INDEXER_RUN_STALE_MINUTES', errors);
  positiveInt(env, 'INDEXER_EXTERNAL_PENDING_TTL_DAYS', errors);
  positiveInt(env, 'INDEXER_WEBHOOK_RETRY_BASE_MS', errors);
  positiveInt(env, 'MAX_DEDICATED_INDEXERS_PER_DOC', errors);
  nonNegativeFloat(env, 'CANDIDATE_MIN_CONFIDENCE', errors);

  // ── Chat-route NLI intent classifier ───────────────────────────────
  positiveInt(env, 'CHAT_ROUTE_NLI_TIMEOUT_MS', errors);

  // ── MCP pack tools (migration 0068) ────────────────────────────────
  positiveInt(env, 'MCP_PACK_TOOLS_CACHE_TTL_MS', errors);

  // ── Worker-loop concurrency (per-jobType poller) ────────────────────
  validateWorkerConcurrencyEnv(env, errors);

  // ── Typed-dispatch per-lane ablation ───────────────────────────────
  validateLanesDisabled(env, errors);

  // ── All remaining boolean feature flags ────────────────────────────
  validateBooleanFlags(env, warnings);

  for (const w of warnings) log.warn(w);

  if (errors.length > 0) {
    const msg = [
      'Environment validation failed. Refusing to start.',
      '',
      ...errors.map((e) => `  • ${e}`),
      '',
      'See .env.example for the full reference.',
    ].join('\n');
    throw new Error(msg);
  }

  log.log('Environment validation passed');
}

/**
 * withScopedCompany() signs in as the brain_caller EDITOR so the
 * SurrealDB PERMISSIONS in migration 0005 gate sensitive fields at the
 * database layer. When SURREALDB_SCOPED_USER/PASS are unset it falls back
 * to the ROOT pool — silently bypassing that fence, leaving only the
 * app-layer JS policy filter. In production that fail-open is a privacy
 * hole, so refuse to start; in dev, warn loudly.
 */
function validateProductionGuards(
  env: NodeJS.ProcessEnv,
  errors: string[],
  warnings: string[],
): void {
  const isProd = env.NODE_ENV === 'production';

  const haveScoped =
    !!env.SURREALDB_SCOPED_USER?.trim() && !!env.SURREALDB_SCOPED_PASS?.trim();
  if (!haveScoped) {
    if (isProd) {
      errors.push(
        'SURREALDB_SCOPED_USER and SURREALDB_SCOPED_PASS must BOTH be set in ' +
          'production — without them withScopedCompany() falls back to the ' +
          'root pool and the DB-level PII fence (migration 0005) is bypassed.',
      );
    } else {
      warnings.push(
        'SURREALDB_SCOPED_USER/PASS not set — DB-level PII fence inactive ' +
          '(app-layer policy only). Set both before deploying.',
      );
    }
  } else if (env.SURREALDB_SCOPED_PASS?.trim() === SHIPPED_SCOPED_PASS_DEFAULT) {
    // The placeholder shipped in migration 0005 is public (it's in the repo).
    // Setting it verbatim leaves the brain_caller account on a known password,
    // which is no better than no fence at all.
    const msg =
      'SURREALDB_SCOPED_PASS is set to the public placeholder from migration ' +
      '0005 — choose a real secret; the shipped default is known to anyone ' +
      'with the source.';
    if (isProd) errors.push(msg);
    else warnings.push(msg);
  }

  // Test-only kill switch must never run in production.
  if (isProd && envFlagEnabled(env.THROTTLE_DISABLED)) {
    errors.push(
      'THROTTLE_DISABLED=1 is a test-only flag and must not be set in ' +
        'production — it disables all rate limiting, including the ' +
        'expensive OpenAI-budget caps.',
    );
  }
}

/**
 * SYNTHESIZE_LANES_DISABLED drives one-variable-per-leg eval ablations;
 * an unnoticed typo ("t7", "recensy") would silently ablate NOTHING and
 * the leg would measure the full dispatcher — reject unknown tokens.
 */
function validateLanesDisabled(env: NodeJS.ProcessEnv, errors: string[]): void {
  if (env.SYNTHESIZE_LANES_DISABLED === undefined) return;
  const { unknown } = parseDisabledLanes(env.SYNTHESIZE_LANES_DISABLED);
  if (unknown.length > 0) {
    errors.push(
      `SYNTHESIZE_LANES_DISABLED contains unknown lane tokens: ` +
        `${unknown.join(', ')} (known: t1..t7 or temporal, enumeration, ` +
        `contradiction, preference, recency, summary, instruction)`,
    );
  }
}

/**
 * PROCESS_ROLE maps one env to the api/worker flag bundle (see
 * common/process-role.ts). Two failure shapes are caught here:
 *   - a typo'd role (PROCESS_ROLE=apy) would silently apply NO bundle
 *     and the pod would run everything — the exact misconfiguration the
 *     convenience exists to prevent;
 *   - api/worker with JOBS_QUEUE_MODE != enqueue: inline mode executes
 *     jobs inside whatever process fired the cron, so the "api-only"
 *     pod would still run compaction/dreams in-process. The queue modes
 *     parse as `=== 'enqueue'`, so ANY other value (including a typo)
 *     means inline behavior and is rejected alongside it.
 */
function validateProcessRole(env: NodeJS.ProcessEnv, errors: string[]): void {
  if (env.PROCESS_ROLE === undefined) return;
  const role = normalizeProcessRole(env.PROCESS_ROLE);
  if (!isProcessRole(role)) {
    errors.push(
      `PROCESS_ROLE must be one of api/worker/all (got "${env.PROCESS_ROLE}")`,
    );
    return;
  }
  if (role === 'all') return;
  const mode = (env.JOBS_QUEUE_MODE ?? 'enqueue').trim();
  if (mode !== 'enqueue') {
    errors.push(
      `PROCESS_ROLE=${role} requires JOBS_QUEUE_MODE=enqueue (got "${mode}") — ` +
        'inline mode executes background jobs inside the API process, ' +
        'defeating the role split.',
    );
  }
}

/**
 * MAX_BODY_SIZE feeds body-parser's `limit`. A bad value silently defeats the
 * memory-pinning cap: an unparseable string makes body-parser throw at boot,
 * and a `gb`/`tb` unit lets one request pin gigabytes. Accept only a byte
 * count or a b/kb/mb size.
 */
/**
 * ABAC env knobs (split from validateEnv for the complexity gate).
 * The boolean flags are security-relevant: an unrecognized value
 * (ABAC_ENABLED=yes) silently parsing as OFF is the fail-open shape
 * this validator exists for — same rationale as the pack-trust flags.
 */
function validateAbacEnv(env: NodeJS.ProcessEnv, errors: string[]): void {
  for (const name of [
    'ABAC_ENABLED',
    'ABAC_FORCE_REPORT_ONLY',
    'ABAC_DB_FENCE_ENABLED',
    'SOURCE_META_STRICT',
    'POLICY_META_UNION_ENABLED',
  ]) {
    const v = env[name];
    if (v !== undefined && !FLAG_VALUES.has(v.trim().toLowerCase())) {
      errors.push(
        `${name} must be one of 1/0/true/false (got "${v}") — an ` +
          'unrecognized value would silently disable policy enforcement.',
      );
    }
  }
  positiveInt(env, 'POLICY_CACHE_TTL_MS', errors);
  positiveInt(env, 'POLICY_CACHE_CAP', errors);
  positiveInt(env, 'POLICY_DECISION_RETENTION_DAYS', errors);
  nonNegativeFloat(env, 'POLICY_DECISION_SAMPLE_RATE', errors);
}

/**
 * Every flag in KNOWN_BOOLEAN_FLAGS is parsed with envFlagEnabled, so a
 * value outside 1/0/true/false silently reads as OFF — the fail-open
 * trap. Unlike the ABAC/pack-trust flags (hard errors), a typo here is
 * a warning: nothing security-relevant, but the operator should know.
 */
function validateBooleanFlags(env: NodeJS.ProcessEnv, warnings: string[]): void {
  for (const name of KNOWN_BOOLEAN_FLAGS) {
    const v = env[name];
    if (v !== undefined && !FLAG_VALUES.has(v.trim().toLowerCase())) {
      warnings.push(
        `${name} must be one of 1/0/true/false (got "${v}") — ` +
          'unrecognized values parse as OFF.',
      );
    }
  }
}

/**
 * Worker-loop concurrency knobs. A typo'd value would silently parse as
 * "unset" in the poller (falling back to serial) — validate at boot like
 * the rest of the numeric knobs. The per-jobType overrides are dynamic
 * (WORKER_LOOP_MAX_CONCURRENT_<JOBTYPE>), so sweep every env key with
 * that prefix instead of hard-coding the jobType list.
 */
function validateWorkerConcurrencyEnv(
  env: NodeJS.ProcessEnv,
  errors: string[],
): void {
  positiveInt(env, 'WORKER_LOOP_MAX_CONCURRENT', errors);
  positiveInt(env, 'WORKER_LOOP_TENANT_MAX_CONCURRENT', errors);
  nonNegativeInt(env, 'WORKER_LOOP_GLOBAL_MAX_CONCURRENT', errors);
  for (const name of Object.keys(env)) {
    if (name.startsWith('WORKER_LOOP_MAX_CONCURRENT_')) {
      positiveInt(env, name, errors);
    }
  }
}

function validateBodySize(env: NodeJS.ProcessEnv, errors: string[]): void {
  const maxBody = env.MAX_BODY_SIZE;
  if (maxBody !== undefined && !/^\d+(\.\d+)?(b|kb|mb)?$/i.test(maxBody.trim())) {
    errors.push(
      'MAX_BODY_SIZE must be a byte count or a b/kb/mb size (e.g. "1mb", ' +
        '"512kb", "1048576") — gb/tb and other units are rejected.',
    );
  }
}

/**
 * Values the pack-trust boolean flags accept. Everything else hard-errors
 * at boot: DOMAIN_PACK_REQUIRE_SIGNATURE=yes (or =enabled, or a typo)
 * silently DISABLING signature enforcement is a fail-open on a
 * supply-chain control — the one shape of bug this validator exists for.
 */
const FLAG_VALUES = new Set(['1', '0', 'true', 'false']);

/**
 * Boolean flags parsed via envFlagEnabled outside the ABAC/pack-trust
 * validators. Kept in lockstep with the swept call sites (audit wave P2);
 * boot warns (not errors) on values outside FLAG_VALUES.
 */
const KNOWN_BOOLEAN_FLAGS = [
  'SEARCH_USAGE_RECORDING_ENABLED',
  'SEARCH_USAGE_DECAY_ENABLED',
  // Occlusion ranking: a kept higher-ranked fact suppresses ≥-threshold
  // cosine near-duplicates globally across hits; freed per-entity slots
  // refill with the next non-duplicate facts (read-path, no writes).
  'SEARCH_OCCLUSION_ENABLED',
  // Phase A read-path (typed-memory roadmap): facts compete globally for
  // the window instead of entities; multi-hop hands its hop evidence to
  // synthesis; the generator gets an anchored "today" for date arithmetic.
  'SEARCH_FACT_CENTRIC_ENABLED',
  'MULTI_HOP_SYNTH_EVIDENCE_UNION',
  'SYNTHESIZE_DATE_CONTEXT',
  // T1 typed dispatch: lexical answer-lane router (temporal-distance lane
  // computes elapsed intervals in code and forces the date anchor).
  'SYNTHESIZE_ANSWER_ROUTER_ENABLED',
  // T2b: mention-order questions sort/annotate evidence by earliest
  // grounding-episode date and force a bare ordered-list answer shape.
  'SYNTHESIZE_ORDERING_FIRST_MENTION',
  // T1b: temporal lane renders a pairwise date-interval table (event-
  // anchored benchmarks: no "today", answers read off the pair rows).
  'SYNTHESIZE_TEMPORAL_EVENT_INTERVALS',
  // T6/T2 wide probe: PRF second retrieval for summary/enumeration
  // lanes — recall breadth that a render frame alone cannot provide.
  'SYNTHESIZE_LANE_WIDE_PROBE',
  // T7: unconditional standing-instructions section (probe + render) —
  // instruction-following questions are deliberately neutral, so no
  // lexical route can fire; injection must not be relevance-gated.
  'SYNTHESIZE_INSTRUCTION_LANE',
  // Raw-substrate driver v1: public episodes read API + NDJSON export.
  'EPISODES_API_ENABLED',
  // Raw-substrate driver v1 surface 3: projections registry API + rebuild verb.
  'PROJECTIONS_API_ENABLED',
  // Router lexicon v2: first-person perfect temporal + "order of" shapes
  // (gaps measured on the LME-500 router-ON leg). DEFAULT ON since the
  // engine wave 2026-08; 0/false disables.
  'SYNTHESIZE_ROUTER_LEXICON_V2',
  // Verbatim-recall evidence: assistant-content questions pull role-tagged
  // episode quotes (BM25 + provenance excerpts) regardless of the global
  // lane flags. DEFAULT ON; 0/false disables. Grounded in the LME SSA
  // diagnosis ("facts do not specify…" with the verbatim turn in L0).
  'SYNTHESIZE_VERBATIM_EXCERPTS',
  // E3b object normalization: the extractor proposes a minimal clean value
  // alongside the verbatim span; the server admits it only when every word
  // appears in the grounded span. Default off pending a paid confirm leg.
  'EXTRACTION_OBJECT_NORMALIZE',
  // E3a: the session deriver also emits propositions for assistant-side
  // contributions (recommendations/answers/instructions given) under the
  // "assistance" aspect. Default off; confirm on a FRESH derivedVersion.
  'DERIVER_ASSISTANT_CONTENT',
  // L0 episode substrate (memory-substrate-redesign P1): capture verbatim
  // turns before extraction — lossless, idempotent, LLM-free.
  'EPISODE_SUBSTRATE_ENABLED',
  // P2: episodic retrieval lane — BM25 quotes from L0 as a typed prompt
  // section in synthesis (lossless fallback for extraction misses).
  'SEARCH_EPISODIC_LANE_ENABLED',
  // A1: provenance lane — verbatim source turns of the selected evidence
  // facts (via source.episodeIds) quoted in the synthesis prompt.
  'SYNTHESIZE_SOURCE_EXCERPTS',
  // R1: segment lane — verbatim multi-turn L0 segments retrieved
  // dense+BM25 as units in their own right; optional listwise rerank.
  'SEARCH_SEGMENT_LANE_ENABLED',
  'SEARCH_SEGMENT_LANE_RERANK',
  // R3: agent-qa V2 tool set — masked search + timeline enumerator +
  // literal transcript grep in the ReAct loop.
  'AGENT_QA_TOOLS_V2',
  // Eval-harness primitives: per-call tenant override for admin keys
  // (X-Brain-Tenant) and LLM-free episode-only ingestion.
  'BRAIN_TENANT_OVERRIDE_ENABLED',
  'INGEST_EPISODE_ONLY',
  'SEARCH_PPR_ENABLED',
  'SEARCH_HNSW_ENABLED',
  'SEARCH_RERANKER_ENABLED',
  'SEARCH_HYPE_ENABLED',
  // Default-ON: read as `SEARCH_TOKEN_COUNT_OFFLOAD ?? '1'` before
  // envFlagEnabled, so only an explicit 0/false disables the offload.
  'SEARCH_TOKEN_COUNT_OFFLOAD',
  'MULTI_HOP_EDGE_EXPANSION_ENABLED',
  'EXTRACTOR_SKIP_LLM_ENABLED',
  'EXTRACTOR_LOCAL_NER_WORKER',
  'CALIBRATION_NIGHTLY_REFIT',
  'DREAMS_ENABLED',
  'DREAMS_RUN_SUMMARIZE',
  'DREAMS_DEDUP_ENABLED',
  'DREAMS_RESOLVE_ENABLED',
  'DREAMS_CORROBORATE_ENABLED',
  'DREAMS_COMMUNITIES_ENABLED',
  'DREAMS_LLM_SUMMARY_ENABLED',
  'COMPACTION_PROMOTION_ENABLED',
  'COMPACTION_SUMMARIES',
  'INGEST_INLINE_RESOLUTION_ENABLED',
  'INGEST_INLINE_RESOLUTION_HNSW',
  'EXTRACTOR_DROP_SAID',
  // Dialogue memory mode — Phase 4. On → open/normalized extraction profile:
  // normalized values (not verbatim spans, grounding-drop bypassed), specific
  // coined predicates kept (refinement collapse skipped), actor attribution.
  // Targets the measured recall loss (catch-all predicates + raw-fragment
  // objects). Off (default) → byte-identical closed-vocab extraction.
  'EXTRACTOR_DIALOGUE_PROFILE',
  // Facet routing (dialogue profile). On → a turn containing a list or a proper
  // name also gets a SPECIALIST extraction pass whose only job is that one
  // thing, unioned with the general pass. Strictly additive recall; costs one
  // extra LLM call per detected facet. Off (default) → single pass.
  'EXTRACTOR_ROUTING_ENABLED',
  'INGEST_CONTEXTUAL_FACT_EMBEDDING',
  'INGEST_EVENT_TIME_EXTRACTION',
  'INGEST_BATCH_EDGES',
  'INGEST_BATCH_FACTS',
  // Realtime fact subscriptions (SSE at /v1/live/facts). On → a dedicated
  // per-tenant connection outside both pools holds a LIVE SELECT, with the
  // 30-day changefeed as the gap-replay bridge and the per-row ABAC gate
  // applied to every pushed event. Off (default) → no socket, controller 503s.
  'LIVE_SUBSCRIPTIONS_ENABLED',
  'SEARCH_COMBINED_VECTOR_GRAPH',
  'SEARCH_HIGHLIGHT_ENABLED',
  'AUDIT_CHANGEFEED_ENABLED',
  'DEBUG_TRACE_PERSIST',
  'BGE_M3_WORKER',
  // Default-ON (config default '1' feeds envFlagEnabled); a value outside
  // FLAG_VALUES still parses as OFF, i.e. in-thread NLI inference.
  'CHAT_ROUTE_NLI_WORKER',
  'THROTTLE_DISABLED',
  'INDEXER_WEBHOOK_PUSH_ENABLED',
  'REINDEX_ON_PACK_INSTALL',
  'DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL',
  // Default-ON: read as `PACK_SEED_INGEST_ENABLED ?? '1'` before
  // envFlagEnabled, so only an explicit 0/false skips pack seed ingest.
  'PACK_SEED_INGEST_ENABLED',
  'DOMAIN_PACK_BILLING_ENABLED',
  'MCP_PACK_TOOLS_ENABLED',
  // Default-ON under the master flag: read as
  // `MCP_PACK_QUERY_TOOLS_ENABLED ?? '1'` before envFlagEnabled.
  'MCP_PACK_QUERY_TOOLS_ENABLED',
  'MCP_PACK_EXTERNAL_TOOLS_ENABLED',
  // Dev/test only — permits http + loopback endpoints (disables the
  // egress guard's SSRF fence for pack tool calls).
  'MCP_PACK_TOOLS_ALLOW_HTTP',
];

/**
 * Parse a boolean env flag accepting BOTH house idioms ('1' and 'true',
 * case-insensitive). The repo historically mixed `=== '1'` and
 * `=== 'true'` per file; for security-relevant flags that split is a
 * fail-open trap (`DOMAIN_PACK_REQUIRE_SIGNATURE=1` silently parsed as
 * false by a 'true'-only check). Values outside FLAG_VALUES are rejected
 * at boot by validatePackTrustEnv for the pack-trust flags.
 */
export function envFlagEnabled(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Default-ON flags: enabled unless explicitly set to 0/false. Use for
 * engine defaults promoted from measured legs (precedent:
 * SEARCH_EDGE_EXPANSION_ENABLED); the kill-switch stays for genre
 * profiles and ablation legs.
 */
export function envFlagNotDisabled(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

function validatePackTrustEnv(env: NodeJS.ProcessEnv, errors: string[]): void {
  for (const name of [
    'DOMAIN_PACK_REQUIRE_SIGNATURE',
    'PACK_REGISTRY_REQUIRE_SIGNATURE',
  ]) {
    const v = env[name];
    if (v !== undefined && !FLAG_VALUES.has(v.trim().toLowerCase())) {
      errors.push(
        `${name} must be one of 1/0/true/false (got "${v}") — an ` +
          'unrecognized value would silently disable signature enforcement.',
      );
    }
  }

  const trusted = env.DOMAIN_PACK_TRUSTED_KEYS;
  if (trusted !== undefined && trusted.trim() !== '') {
    try {
      const parsed = JSON.parse(trusted);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((k) => typeof k !== 'string')
      ) {
        errors.push(
          'DOMAIN_PACK_TRUSTED_KEYS must be a JSON object mapping publisher → PEM public key',
        );
      }
    } catch (e) {
      errors.push(
        `DOMAIN_PACK_TRUSTED_KEYS is not valid JSON: ${(e as Error).message} — ` +
          'a malformed trust store makes every signed pack "unknown publisher".',
      );
    }
  }
}

/**
 * Pull-only registry mirroring (RegistryMirrorService). A malformed
 * REGISTRY_UPSTREAM_URL would make every sync run fail at fetch time —
 * catch it at boot instead. REGISTRY_UPSTREAM_TOKEN is a free-form bearer
 * (nothing to validate); the interval shares the positiveInt idiom.
 */
function validateRegistryMirrorEnv(
  env: NodeJS.ProcessEnv,
  errors: string[],
): void {
  const url = env.REGISTRY_UPSTREAM_URL;
  if (url !== undefined && url.trim() !== '') {
    let valid = false;
    try {
      const parsed = new URL(url.trim());
      valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      valid = false;
    }
    if (!valid) {
      errors.push(
        'REGISTRY_UPSTREAM_URL must be a valid http(s) URL — the pull-only ' +
          'registry mirror fetches the upstream catalogue from it.',
      );
    }
  }
  positiveInt(env, 'REGISTRY_MIRROR_INTERVAL_HOURS', errors);
}

/**
 * Marketplace billing (paid packs via the central billing service).
 * When DOMAIN_PACK_BILLING_ENABLED is on, the client needs a reachable
 * base URL and a service API key — a missing/typo'd value would
 * otherwise surface per-request as 503s on every paid-pack install
 * (the client fails CLOSED). Mirrors validateRegistryMirrorEnv.
 */
function validateBillingEnv(env: NodeJS.ProcessEnv, errors: string[]): void {
  const enabled = envFlagEnabled(env.DOMAIN_PACK_BILLING_ENABLED);
  const url = env.BILLING_SERVICE_URL;
  if (url !== undefined && url.trim() !== '') {
    let valid = false;
    try {
      const parsed = new URL(url.trim());
      valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      valid = false;
    }
    if (!valid) {
      errors.push(
        'BILLING_SERVICE_URL must be a valid http(s) URL — the marketplace ' +
          'billing client calls it for products, checkout and entitlements.',
      );
    }
  } else if (enabled) {
    errors.push(
      'BILLING_SERVICE_URL is required when DOMAIN_PACK_BILLING_ENABLED is on.',
    );
  }
  if (enabled && !env.BILLING_SERVICE_API_KEY?.trim()) {
    errors.push(
      'BILLING_SERVICE_API_KEY is required when DOMAIN_PACK_BILLING_ENABLED ' +
        'is on — the billing service authenticates brain via x-api-key.',
    );
  }
  positiveInt(env, 'BILLING_TIMEOUT_MS', errors);
  positiveInt(env, 'BILLING_ENTITLEMENT_CACHE_TTL_MS', errors);
}

function required({
  env,
  name,
  errors,
  pattern,
}: {
  env: NodeJS.ProcessEnv;
  name: string;
  errors: string[];
  pattern?: RegExp;
}): void {
  const v = env[name];
  if (!v || !v.trim()) {
    errors.push(`${name} is required`);
    return;
  }
  if (pattern && !pattern.test(v)) {
    errors.push(`${name} does not match expected pattern ${pattern}`);
  }
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, errors: string[]): void {
  const v = env[name];
  if (v === undefined) return;
  if (!/^\d+$/.test(v) || parseInt(v, 10) < 1) {
    errors.push(`${name} must be a positive integer`);
  }
}

/** Like positiveInt, but 0 is a valid (usually "feature off") value. */
function nonNegativeInt(
  env: NodeJS.ProcessEnv,
  name: string,
  errors: string[],
): void {
  const v = env[name];
  if (v === undefined) return;
  if (!/^\d+$/.test(v)) {
    errors.push(`${name} must be a non-negative integer`);
  }
}

function nonNegativeFloat(
  env: NodeJS.ProcessEnv,
  name: string,
  errors: string[],
): void {
  const v = env[name];
  if (v === undefined) return;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`${name} must be a non-negative number`);
  }
}
