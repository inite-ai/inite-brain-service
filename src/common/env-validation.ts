import { Logger } from '@nestjs/common';
import { isProcessRole, normalizeProcessRole } from './process-role';

const log = new Logger('EnvValidation');

// The placeholder password baked into migration 0005's `DEFINE USER
// brain_caller`. It is public (lives in the repo), so deploying with it
// unchanged leaves the scoped account on a known credential.
const SHIPPED_SCOPED_PASS_DEFAULT = 'brain-caller-password-must-be-overridden-via-env';

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
        warnings.push('BRAIN_API_KEYS is empty in production — no caller can authenticate');
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
      warnings.push('FORGET_HMAC_KEY uses an insecure default. Set it before deploying.');
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
  nonNegativeFloat(env, 'SEARCH_RERANK_TRUST_BAND', errors);
  nonNegativeFloat(env, 'SEARCH_CORROBORATION_GAMMA', errors);
  nonNegativeFloat(env, 'SEARCH_AUTHORITY_DELTA', errors);
  nonNegativeFloat(env, 'SYNTHESIZE_MIN_FACT_TRUST', errors);

  // ── G8 trace-derived usage ranking (migration 0053) ────────────────
  // β = strength (0 = off); saturation = readCount at which the boost tops
  // out. A typo would silently parseInt→NaN / fall back to the default.
  nonNegativeFloat(env, 'SEARCH_USAGE_BETA', errors);
  positiveInt(env, 'SEARCH_USAGE_SATURATION', errors);

  // ── Retrieval fact-shaping (chatter demotion) ──────────────────────
  // Penalty is read with a (0,1] clamp; nonNegativeFloat only guards the
  // "is a number" contract here (≥1 is accepted and means "no penalty").
  nonNegativeFloat(env, 'SEARCH_CHATTER_PENALTY', errors);

  // ── G4 strategy-memory lane ────────────────────────────────────────
  // Serving similarity floor (default 0.4); a typo would silently fall
  // back to the default in the constructor-captured read.
  nonNegativeFloat(env, 'STRATEGY_SIMILARITY_FLOOR', errors);

  // ── Phase A read-path (typed-memory roadmap 2026-07) ───────────────
  positiveInt(env, 'SEARCH_FACT_CENTRIC_BUDGET', errors);
  positiveInt(env, 'SYNTHESIZE_EXTRA_EVIDENCE_CAP', errors);
  positiveInt(env, 'SEARCH_EPISODIC_LANE_TOPK', errors);
  positiveInt(env, 'SYNTHESIZE_SOURCE_EXCERPTS_CAP', errors);
  positiveInt(env, 'SEARCH_SEGMENT_LANE_TOPK', errors);

  positiveInt(env, 'SYNTHESIZE_WIDE_PROBE_LIMIT', errors);

  // ── G1 answer cache (fact-lifecycle-gated answer reuse) ────────────
  positiveInt(env, 'SYNTHESIZE_ANSWER_CACHE_TTL_HOURS', errors);

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

  // ── HNSW on the coverage scan lanes (mention-scan / query_arc) ─────
  positiveInt(env, 'RETRIEVAL_SCAN_HNSW_EF', errors);
  positiveInt(env, 'RETRIEVAL_SCAN_HNSW_OVERFETCH', errors);

  // ── Verifier model override (V11 §2 arm a) ─────────────────────────
  modelIdFormat(env, 'RETRIEVAL_VERIFIER_MODEL', errors);

  // ── V13 raw-turn window (hybrid substrate read side) ───────────────
  positiveInt(env, 'RETRIEVAL_RAW_WINDOW_SPAN', errors);

  // ── Multiworld §10 read-side knobs ─────────────────────────────────
  positiveInt(env, 'RETRIEVAL_ASSISTANT_LANE_TOPK', errors);
  positiveInt(env, 'RETRIEVAL_FACTS_AS_KEYS_CAP', errors);

  // ── G2 L3 escalation lane bounds ───────────────────────────────────
  positiveInt(env, 'RETRIEVAL_L3_MAX_SESSIONS', errors);
  positiveInt(env, 'RETRIEVAL_L3_TOKEN_CAP', errors);

  // ── Communities (dreams sub-op) ────────────────────────────────────
  // 0 is meaningful (= never offload label propagation to the worker
  // pool), so this one is non-negative rather than positive.
  nonNegativeInt(env, 'COMMUNITIES_LP_OFFLOAD_MIN_EDGES', errors);
  positiveInt(env, 'COMMUNITIES_MIN_SIZE', errors);
  positiveInt(env, 'COMMUNITIES_MAX_ITERATIONS', errors);
  positiveInt(env, 'COMMUNITIES_SUMMARY_MAX_MEMBERS', errors);

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

  // ── Retrieval profile (per-tenant genre configuration) ─────────────
  validateRetrievalProfileEnv(env, errors);

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

  const haveScoped = !!env.SURREALDB_SCOPED_USER?.trim() && !!env.SURREALDB_SCOPED_PASS?.trim();
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
    errors.push(`PROCESS_ROLE must be one of api/worker/all (got "${env.PROCESS_ROLE}")`);
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
function validateWorkerConcurrencyEnv(env: NodeJS.ProcessEnv, errors: string[]): void {
  positiveInt(env, 'WORKER_LOOP_MAX_CONCURRENT', errors);
  positiveInt(env, 'WORKER_LOOP_TENANT_MAX_CONCURRENT', errors);
  nonNegativeInt(env, 'WORKER_LOOP_GLOBAL_MAX_CONCURRENT', errors);
  for (const name of Object.keys(env)) {
    if (name.startsWith('WORKER_LOOP_MAX_CONCURRENT_')) {
      positiveInt(env, name, errors);
    }
  }
}

/**
 * Retrieval-profile enum keys + the per-tenant overrides JSON. A typo'd
 * enum would silently fall back to the derived default — the exact
 * misconfiguration shape a genre profile exists to prevent — so reject
 * at boot. Overrides only need to parse as an object-of-objects; the
 * per-field validation is lenient inside resolveRetrievalProfileFor.
 */
function validateRetrievalProfileEnv(env: NodeJS.ProcessEnv, errors: string[]): void {
  const enums: Array<[string, string[]]> = [
    ['RETRIEVAL_GENRE', ['dialogue', 'assistant_chat', 'documents']],
    ['RETRIEVAL_VERBATIM_EVIDENCE', ['off', 'shape_conditioned', 'always', 'fused', 'routed']],
    ['RETRIEVAL_INSIGHT_EVIDENCE', ['off', 'routed', 'query_arc']],
    ['RETRIEVAL_TIMELINE_EVIDENCE', ['off', 'routed', 'scan']],
    ['RETRIEVAL_COVERAGE_SCAN_MODE', ['brute', 'hnsw']],
    ['RETRIEVAL_COVERAGE_LEX_MODE', ['phrase', 'or_terms']],
    ['RETRIEVAL_ABSTENTION_CALIBRATION', ['off', 'coverage', 'verifier', 'minicheck']],
    ['RETRIEVAL_DATE_ANCHORING', ['none', 'session_date', 'absolute']],
    ['RETRIEVAL_TEMPORAL_MODE', ['filter', 'overlap_boost']],
    ['RETRIEVAL_DIGEST_LANES', ['all', 'summary_ku']],
  ];
  for (const [name, allowed] of enums) {
    const v = env[name];
    if (v !== undefined && v.trim() !== '' && !allowed.includes(v.trim())) {
      errors.push(`${name} must be one of ${allowed.join('/')} (got "${v}")`);
    }
  }
  const raw = env.RETRIEVAL_PROFILE_OVERRIDES;
  if (raw !== undefined && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((o) => o === null || typeof o !== 'object' || Array.isArray(o))
      ) {
        errors.push(
          'RETRIEVAL_PROFILE_OVERRIDES must be a JSON object mapping ' +
            'companyId → partial retrieval profile',
        );
      }
    } catch (e) {
      errors.push(`RETRIEVAL_PROFILE_OVERRIDES is not valid JSON: ${(e as Error).message}`);
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
  // G8 trace-derived ranking: read fact_usage.readCount into the usage
  // ranking factor (needs recording ON first for data).
  'SEARCH_USAGE_RANKING_ENABLED',
  // Phase A read-path (typed-memory roadmap): the generator gets an
  // anchored "today" for date arithmetic.
  'SYNTHESIZE_DATE_CONTEXT',
  // T1 typed dispatch: lexical answer-lane router (temporal-distance lane
  // computes elapsed intervals in code and forces the date anchor).
  'SYNTHESIZE_ANSWER_ROUTER_ENABLED',
  // T6/T2 wide probe: PRF second retrieval for summary/enumeration
  // lanes — recall breadth that a render frame alone cannot provide.
  'SYNTHESIZE_LANE_WIDE_PROBE',
  // T7: unconditional standing-instructions section (probe + render) —
  // instruction-following questions are deliberately neutral, so no
  // lexical route can fire; injection must not be relevance-gated.
  'SYNTHESIZE_INSTRUCTION_LANE',
  // G1 answer cache: exact-normalized-match answer reuse gated by
  // check-on-read over the cited facts' lifecycle state. Default off.
  'SYNTHESIZE_ANSWER_CACHE',
  // Raw-substrate driver v1: public episodes read API + NDJSON export.
  'EPISODES_API_ENABLED',
  // Fact read + provenance API: GET /v1/facts/:id and /:id/provenance
  // (grounding episodes). The retract write path stays ungated (GDPR).
  'FACTS_API_ENABLED',
  // Raw-substrate driver v1 surface 3: projections registry API + rebuild verb.
  'PROJECTIONS_API_ENABLED',
  // Raw-substrate driver v1 surface 4: new-episode webhook push (watermark
  // poll over recordedAt, metadata-only payloads, HMAC-signed).
  'EPISODE_SUBSCRIPTIONS_ENABLED',
  // Rolling user profile v1: GET /v1/users/:userId/profile —
  // deterministic per-user profile assembly for prompt injection.
  // Default off → routes 404.
  'USER_PROFILE_API_ENABLED',
  // E3b object normalization: the extractor proposes a minimal clean value
  // alongside the verbatim span; the server admits it only when every word
  // appears in the grounded span. Default off pending a paid confirm leg.
  'EXTRACTION_OBJECT_NORMALIZE',
  // E3a: the session deriver also emits propositions for assistant-side
  // contributions (recommendations/answers/instructions given) under the
  // "assistance" aspect. Default off; confirm on a FRESH derivedVersion.
  'DERIVER_ASSISTANT_CONTENT',
  // V9 §1: value-bearing aspects take the bitemporal_event lifecycle
  // (supersede + competing) in derived worlds. Default off.
  'DERIVER_SLOT_SEMANTICS',
  // V12 §1: per-fact mention anchor (source.mentionedAt/turnIndex from
  // the first grounding turn's occurredAt). Default off.
  'DERIVER_MENTION_STAMP',
  // V13 structural: per-turn timestamp headers in the deriver
  // transcript + resolve occurred_on against the turn's own timestamp
  // (session-date fallback kept). Default off; fresh derivedVersion.
  'DERIVER_TURN_HEADERS',
  // V12 §3: occurred_on anti-collapse prompt rules (date the EVENT,
  // resolve relative time, null over session-date default). Default
  // off; confirms only on a FRESH derivedVersion.
  'DERIVER_DATE_RESOLVE',
  // V13: dedicated after-emission date audit turn (the post-pass shape
  // of the failed prompt rules). Default off; fresh derivedVersion.
  'DERIVER_DATE_AUDIT',
  // V13 A2: mechanical per-(entity, aspect) rollup facts at write time
  // (the MH-enumeration lever). Default off; fresh derivedVersion.
  'DERIVER_ASPECT_ROLLUPS',
  // V13: cross-session LLM composition pass (PREMem shape) — one call
  // per conversation over landed atoms. Default off; fresh
  // derivedVersion.
  'DERIVER_COMPOSE_PASS',
  // V13: dual-trace encoding — per-proposition scene clause stamped
  // and folded into the embedding. Default off; fresh derivedVersion.
  'DERIVER_SCENE_TRACE',
  // Multiworld §10: typed single-pass derive — every proposition tagged
  // kind ∈ {fact, assistant_contribution, persona_attr, event}, stamped
  // as source.kind. Default off; fresh derivedVersion.
  'DERIVER_TYPED_ATOMS',
  // G3: per-grounding-turn verbatim quotes from the deriver, verified
  // mechanically into char spans (source.charSpans). Default off;
  // prompt + schema change ⇒ fresh derivedVersion.
  'DERIVER_SPANS',
  // V12 §2: rolling per-conversation digest fold (conversation_digest,
  // 0086). Default off.
  'DERIVER_DIGEST',
  // RetrievalProfile boolean points (V8-V10). Parsed with
  // envFlagEnabled inside resolveRetrievalProfile — same fail-open
  // typo trap as every other flag here ('yes' silently reads OFF).
  'RETRIEVAL_ENTITY_EXPANSION',
  'RETRIEVAL_SALIENCE_SCORING',
  'RETRIEVAL_UPDATE_STORY',
  'RETRIEVAL_DIGEST_EVIDENCE',
  'RETRIEVAL_ORDERING_FRAME',
  'RETRIEVAL_VERIFIER_TOPIC_COVERAGE',
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
  // July A3: cross-encoder rescoring of the fused fact pool before the
  // fact-centric budget cut. Default off pending a paired leg.
  'SEARCH_FACT_RERANK',
  // V12 read side of DERIVER_MENTION_STAMP: "(mentioned YYYY-MM-DD)"
  // fact-line suffix when the anchor disagrees with validFrom by day.
  'RETRIEVAL_MENTION_DATES',
  // §8 item 3: enumeration scope discipline — only items the facts tie
  // to the asked scope; extras sink strict-judged list answers.
  'RETRIEVAL_ENUM_STRICT',
  // V13 dual-trace read side: "(context: …)" scene suffix on stamped
  // fact lines. Default off.
  'RETRIEVAL_SCENE_TRACES',
  // V13 hybrid substrate: fact hits expand into bounded raw-turn
  // windows rendered as transcript evidence. Default off.
  'RETRIEVAL_RAW_WINDOW',
  // Multiworld §10: assistant-role verbatim lane over L0 (the SSA
  // structural fix — the gold class facts never carry). Default off.
  'RETRIEVAL_ASSISTANT_LANE',
  // Multiworld §10: facts-as-keys — top evidence fact lines carry one
  // verbatim grounding quote (fact = key, raw turn = content).
  // Default off.
  'RETRIEVAL_FACTS_AS_KEYS',
  // V13 TSM-shape time-constrained retrieval: code-parsed query period
  // boosts in-range facts (rank-only, nothing dropped). Default off.
  'RETRIEVAL_TIME_FILTER',
  // V13 deterministic date table (weekday + event-to-event gaps) so the
  // generator never does raw calendar math. Default off.
  'RETRIEVAL_DATE_MATH',
  // V13 G2: per-question-shape answer instructions from the code-side
  // shape detectors. Default off.
  'RETRIEVAL_ANSWER_CONDITIONING',
  // V13 LIGHT noise filter: cross-encoder relevance gate on injected
  // context lines (facts never filtered). Default off.
  'RETRIEVAL_NOISE_FILTER',
  // V13 constrained search loop: one structured refine round, then a
  // forced answer. Default off.
  'RETRIEVAL_SEARCH_LOOP',
  // G2 (sota-gap-build-2026-08): confidence-gated L3 escalation — on a
  // verifier-fail with an anchoring session, escalate to one full-raw-
  // session large-context generation, re-verify, return only on flip.
  // Default off = byte-identical (the fact-only verdict stands).
  'RETRIEVAL_L3_ESCALATION',
  // R3: agent-qa V2 tool set — masked search + timeline enumerator +
  // literal transcript grep in the ReAct loop.
  'AGENT_QA_TOOLS_V2',
  // Eval-harness primitives: per-call tenant override for admin keys
  // (X-Brain-Tenant) and LLM-free episode-only ingestion.
  'BRAIN_TENANT_OVERRIDE_ENABLED',
  'INGEST_EPISODE_ONLY',
  'SEARCH_PPR_ENABLED',
  'SEARCH_HNSW_ENABLED',
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
  // G9 (docs/roadmap/sota-gap-build-2026-08.md): NFC-normalize + strip
  // bidi/zero-width/control chars from ingest text (mention/fact/
  // document/candidate) before storage. Default off = byte-identical.
  'INGEST_SANITIZE_UNICODE',
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
  // 0088 stats views: tenant counter reads come from the incrementally
  // maintained count() rollup tables instead of live GROUP aggregates.
  // Off (default) → byte-identical pre-0088 live counting.
  'STATS_VIEWS_ENABLED',
  // G6 scope-tag fence (0093): the scope-tag visibility evaluator runs
  // as an ADDITIONAL AND-fence alongside the untouched 0055 userId
  // filter. Off (default) → the scope column is written but never read;
  // enforcement is byte-identical pre-0093.
  'SCOPE_TAGS_ENABLED',
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
  // G4 strategy-memory lane (0092): master switch (lane + admin
  // endpoints + cron), read-side serving switch, and the nightly
  // lifecycle-sweep cron. All default off.
  'STRATEGY_MEMORY_ENABLED',
  'STRATEGY_RETRIEVAL_ENABLED',
  'STRATEGY_DISTILL_CRON_ENABLED',
  // Fovea optics (Optics-1, docs/roadmap/fovea-optics-2026-08.md): capture
  // the focus signal at the synthesize verdict point + expose the admin
  // fit/measure surface. SERVING-NEUTRAL — nothing consumes the calibrated
  // signal yet. Default off = byte-identical serving (guarded no-op capture,
  // admin routes 404). Outside ENGINE_PREFIX by design (a measurement
  // scaffold, not an engine fork), so it sits off the flag budget.
  'FOVEA_FOCUS_CAPTURE',
  // Fovea optics (Optics-2, §4.1): make the L3 escalation trigger +
  // session-count adaptive to the calibrated focus confidence. Requires a
  // usable per-class calibration model; with none — or off — serving is
  // byte-identical to the static L3. Outside ENGINE_PREFIX by design (the
  // FOVEA_ family sits off the flag budget). The escalate threshold knob
  // (FOVEA_ADAPTIVE_L3_THRESHOLD) is a float, not a boolean flag.
  'FOVEA_ADAPTIVE_L3',
  // Fovea optics (Optics §4.2): make the pre-generation coverage-abstention
  // decision adaptive to the calibrated PRE-ANSWER focus confidence,
  // replacing the static coverage floor. Requires a usable per-class
  // pre-answer calibration model; with none — or off — serving is
  // byte-identical to the static coverage abstention. Outside ENGINE_PREFIX
  // by design (the FOVEA_ family sits off the flag budget). The abstain
  // threshold knob (FOVEA_ADAPTIVE_ABSTAIN_THRESHOLD) is a float, not a
  // boolean flag.
  'FOVEA_ADAPTIVE_ABSTAIN',
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
 * per-tenant kill-switches on genre-dependent behavior; measured-winner
 * defaults fold into the code instead of keeping a flag.
 */
export function envFlagNotDisabled(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

function validatePackTrustEnv(env: NodeJS.ProcessEnv, errors: string[]): void {
  for (const name of ['DOMAIN_PACK_REQUIRE_SIGNATURE', 'PACK_REGISTRY_REQUIRE_SIGNATURE']) {
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
function validateRegistryMirrorEnv(env: NodeJS.ProcessEnv, errors: string[]): void {
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
    errors.push('BILLING_SERVICE_URL is required when DOMAIN_PACK_BILLING_ENABLED is on.');
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

/** Set-but-malformed model ids fail boot loudly; empty/unset = inherit. */
function modelIdFormat(env: NodeJS.ProcessEnv, name: string, errors: string[]): void {
  const v = env[name];
  if (v !== undefined && v.trim() !== '' && !/^[A-Za-z0-9._:/-]{1,64}$/.test(v.trim())) {
    errors.push(`${name} must be a plain model id (letters, digits, . _ : / -, max 64 chars)`);
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
function nonNegativeInt(env: NodeJS.ProcessEnv, name: string, errors: string[]): void {
  const v = env[name];
  if (v === undefined) return;
  if (!/^\d+$/.test(v)) {
    errors.push(`${name} must be a non-negative integer`);
  }
}

function nonNegativeFloat(env: NodeJS.ProcessEnv, name: string, errors: string[]): void {
  const v = env[name];
  if (v === undefined) return;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`${name} must be a non-negative number`);
  }
}
