import { Logger } from '@nestjs/common';

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

  // ── fact_trust ranking knobs (source-reputation Phase 5) ──────────
  nonNegativeFloat(env, 'SEARCH_TRUST_BETA', errors);
  nonNegativeFloat(env, 'SEARCH_CORROBORATION_GAMMA', errors);
  nonNegativeFloat(env, 'SEARCH_AUTHORITY_DELTA', errors);
  nonNegativeFloat(env, 'SYNTHESIZE_MIN_FACT_TRUST', errors);

  // ── Read-side query expansion ──────────────────────────────────────
  positiveInt(env, 'SEARCH_QUERY_EXPANSION_N', errors);

  // ── Episodic→semantic promotion (compaction leg) ───────────────────
  positiveInt(env, 'COMPACTION_PROMOTION_AGE_DAYS', errors);
  positiveInt(env, 'COMPACTION_PROMOTION_MIN_GROUP', errors);
  positiveInt(env, 'COMPACTION_PROMOTION_MAX_GROUPS', errors);

  // ── HNSW vector leg ────────────────────────────────────────────────
  positiveInt(env, 'SEARCH_HNSW_EF', errors);
  positiveInt(env, 'SEARCH_HNSW_OVERFETCH', errors);

  // ── Communities (dreams sub-op) ────────────────────────────────────
  // 0 is meaningful (= never offload label propagation to the worker
  // pool), so this one is non-negative rather than positive.
  nonNegativeInt(env, 'COMMUNITIES_LP_OFFLOAD_MIN_EDGES', errors);

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
  positiveInt(env, 'MAX_DEDICATED_INDEXERS_PER_DOC', errors);
  nonNegativeFloat(env, 'CANDIDATE_MIN_CONFIDENCE', errors);

  // ── Chat-route NLI intent classifier ───────────────────────────────
  positiveInt(env, 'CHAT_ROUTE_NLI_TIMEOUT_MS', errors);

  // ── Worker-loop concurrency (per-jobType poller) ────────────────────
  validateWorkerConcurrencyEnv(env, errors);

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
  'SEARCH_PPR_ENABLED',
  'SEARCH_HNSW_ENABLED',
  'SEARCH_RERANKER_ENABLED',
  'SEARCH_HYPE_ENABLED',
  'MULTI_HOP_EDGE_EXPANSION_ENABLED',
  'EXTRACTOR_SKIP_LLM_ENABLED',
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
  'AUDIT_CHANGEFEED_ENABLED',
  'DEBUG_TRACE_PERSIST',
  'BGE_M3_WORKER',
  // Default-ON (config default '1' feeds envFlagEnabled); a value outside
  // FLAG_VALUES still parses as OFF, i.e. in-thread NLI inference.
  'CHAT_ROUTE_NLI_WORKER',
  'THROTTLE_DISABLED',
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
