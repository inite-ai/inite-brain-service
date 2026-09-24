import { Logger } from '@nestjs/common';
import {
  validateEvidenceOrphanGcEnv,
  validateEvidenceStorageEnv,
  validateOcrEnvValues,
} from './evidence-flags';
import { KNOWN_BOOLEAN_FLAGS } from './known-boolean-flags';
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
  // Required UNCONDITIONALLY, EMBEDDER_PROVIDER=bge-m3 included: the local
  // embedder removes the key's embedding role, not its LLM role — the
  // extractor, generator, verifier, deriver, chat router and multi-hop
  // planner all build an OpenAI client eagerly in their constructors, so a
  // key-less boot fails there instead of here.
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
      // Static keys are one of three ways in: JWKS-verified tokens
      // (AUTH_SERVICE_JWKS_URL — production's actual path, where static
      // keys are refused) and self-issued keys from the keys table are the
      // others. The warning is about NO way in, not about this one.
      if (
        parsed.length === 0 &&
        env.NODE_ENV === 'production' &&
        !env.AUTH_SERVICE_JWKS_URL &&
        !env.AUTH_SERVICE_URL
      ) {
        warnings.push(
          'BRAIN_API_KEYS is empty and no AUTH_SERVICE_JWKS_URL is set in production — only keys issued through /v1/keys can authenticate',
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
      warnings.push('FORGET_HMAC_KEY uses an insecure default. Set it before deploying.');
    }
  } else if (env.FORGET_HMAC_KEY.length < 32) {
    warnings.push('FORGET_HMAC_KEY is shorter than 32 chars — recommended ≥ 32');
  }

  // ── Production-only guards (scoped pool + test-only kill switches) ─
  validateProductionGuards(env, errors, warnings);

  // ── Process role (api / worker split) ─────────────────────────────
  validateProcessRole(env, errors);

  // ── Pool sizes ────────────────────────────────────────────────────
  // Both pools take the same guard — the same one every other integer
  // knob here gets. The scoped pool's failure is the quieter of the two:
  // a typo parses to NaN, the build loop runs zero times while
  // scopedPoolEnabled() stays true, and every read then waits for a
  // connection that will never exist — the replica sits permanently
  // not-ready with nothing naming the cause.
  positiveInt(env, 'SURREALDB_POOL_SIZE', errors);
  positiveInt(env, 'SURREALDB_SCOPED_POOL_SIZE', errors);

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

  // ── Verified-use successor ranking (0107 outcome telemetry) ────────
  // Same shape as the G8 pair: β = strength (0 = off); saturation = the
  // verifiedUseScore at which the boost tops out.
  nonNegativeFloat(env, 'SEARCH_VERIFIED_USE_BETA', errors);
  positiveInt(env, 'SEARCH_VERIFIED_USE_SATURATION', errors);

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
  positiveInt(env, 'SYNTHESIZE_ANSWER_CACHE_ENUM_TTL_HOURS', errors);
  // Language-agnostic enum guard: cited-fact count at which an answer is
  // treated as enumeration-shaped (short TTL) regardless of query language.
  positiveInt(env, 'SYNTHESIZE_ANSWER_CACHE_ENUM_MIN_CITATIONS', errors);

  // ── Agent-in-loop QA ───────────────────────────────────────────────
  positiveInt(env, 'AGENT_QA_MAX_ROUNDS', errors);
  positiveInt(env, 'AGENT_QA_SEARCH_LIMIT', errors);
  positiveInt(env, 'AGENT_QA_MAX_FACTS_PER_ROUND', errors);

  // ── Episodic→semantic promotion (compaction leg) ───────────────────
  positiveInt(env, 'COMPACTION_PROMOTION_AGE_DAYS', errors);
  positiveInt(env, 'COMPACTION_PROMOTION_MIN_GROUP', errors);
  positiveInt(env, 'COMPACTION_PROMOTION_MAX_GROUPS', errors);
  // Corroboration floor of the promotion consolidation gate (Brain v2
  // PR8). 0 is meaningful (= floor off, the default), so non-negative.
  nonNegativeInt(env, 'COMPACTION_PROMOTION_MIN_EPISODES', errors);

  // ── Per-tenant compaction schedule (COMPACTION_TENANT_OVERRIDES) ───
  validateCompactionOverridesEnv(env, warnings);

  // ── HNSW vector leg ────────────────────────────────────────────────
  positiveInt(env, 'SEARCH_HNSW_EF', errors);
  positiveInt(env, 'SEARCH_HNSW_OVERFETCH', errors);

  // ── HNSW index provisioning + reconciliation ───────────────────────
  // 0 is meaningful on both (no budget / no builds started this run), so
  // non-negative rather than positive.
  nonNegativeInt(env, 'HNSW_PROVISION_TIME_BUDGET_MS', errors);
  nonNegativeInt(env, 'HNSW_PROVISION_MAX_BUILDS_PER_RUN', errors);

  // ── HNSW on the inline entity-resolution name-candidate scan ───────

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

  // ── Scenes shadow substrate (Brain v2 PR1, migration 0106) ─────────
  // The composer clamps bad values to defaults at read time; boot
  // validation catches the typo before it silently reads as a default.
  positiveInt(env, 'SCENES_MAX_TURNS', errors);
  floatInRange(env, 'SCENES_TOPIC_MIN_COSINE', -1, 1, errors);
  // Belief promotion floor (Belief-A, migration 0120): 0 = off.
  nonNegativeInt(env, 'SCENES_BELIEF_MIN_SCENES', errors);
  // Memory-value gate noise floor: a [0,1] fraction of the value vector,
  // NOT a count. The gate clamps a bad value to 0.05 at read time; boot
  // validation catches the typo before a "0.5" meant as 50% of scenes
  // silently reads as the default and gates almost nothing.
  floatInRange(env, 'SCENES_VALUE_GATE_MIN', 0, 1, errors);
  // Scheduled maintenance budgets (migration 0130): the nightly pass
  // clamps bad values to defaults at read time; boot validation catches
  // the typo before an unbounded-looking knob silently reads as 200/30min.
  positiveInt(env, 'SCENES_MAINTENANCE_MAX_CONVERSATIONS', errors);
  positiveInt(env, 'SCENES_MAINTENANCE_TIME_BUDGET_MS', errors);

  // ── Evidence substrate (Brain v2.1 M1, migration 0109) ─────────────
  // The write seam clamps bad values to the default at read time; boot
  // validation catches the typo before it silently reads as a default.
  positiveInt(env, 'EVIDENCE_MAX_BYTES', errors);
  // Processing lifecycle (0121): derived-output cap, same clamp contract.
  positiveInt(env, 'EVIDENCE_DERIVED_MAX_BYTES', errors);
  // Orphan-blob GC bounds: the sweep clamps bad values to defaults at
  // read time, but a typo'd grace window is the one that would matter —
  // catch it at boot, before an unreadable value silently reads as 24 h.
  positiveInt(env, 'EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS', errors);
  positiveInt(env, 'EVIDENCE_ORPHAN_BLOB_GC_MAX_DELETIONS', errors);
  positiveInt(env, 'EVIDENCE_ORPHAN_BLOB_GC_TIME_BUDGET_MS', errors);
  // Local OCR processor knobs, same clamp contract (the validator lives
  // beside its readers in evidence-flags.ts — see the note there).
  validateOcrEnvValues(env, errors);
  // Store selection + the S3 object store (multi-replica): a scheme
  // outside fs/s3, s3 without a bucket, or half a credential pair is an
  // upload path with nowhere to put bytes — errors, validated beside the
  // readers in evidence-flags.ts.
  validateEvidenceStorageEnv(env, errors);

  // ── Retrieval profile (per-tenant genre configuration) ─────────────
  validateRetrievalProfileEnv(env, errors);

  // ── Evidence plane: claim grounding (Drift-1, migration 0115) ──────
  validateEvidenceGroundingEnv(env, warnings);
  validateEvidenceIngestEnv(env, warnings);
  validateEvidenceGrantsApiEnv(env, warnings);
  validateEvidenceUploadEnv(env, warnings);

  // ── Evidence plane: processing lifecycle (migration 0121) ──────────
  validateEvidenceProcessingEnv(env, warnings);

  // ── Evidence plane: orphan-blob GC (delete-side hygiene) ───────────
  // The validator lives beside its readers in evidence-flags.ts — see
  // the note there.
  validateEvidenceOrphanGcEnv(env, warnings);

  // ── Belief serving: damping requires the lane ──────────────────────
  validateBeliefServingEnv(env, warnings);

  // ── Evidence plane: raw-read gateway (MM-3, migration 0125) ────────
  validateEvidenceRawReadEnv(env, errors, warnings);

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
          'production so withScopedCompany() uses the non-root scoped pool ' +
          'instead of falling back to root. NOTE (R4 audit): the DB-level ' +
          'PERMISSIONS fence (migration 0005) does not currently fire even ' +
          'on the scoped pool — SurrealDB skips PERMISSIONS for the system ' +
          'brain_caller user, so the app-layer filter is the effective PII ' +
          'barrier; the scoped pool is required for parity/readiness for the ' +
          'future Record Access fence.',
      );
    } else {
      warnings.push(
        'SURREALDB_SCOPED_USER/PASS not set — running on the root pool ' +
          '(app-layer policy is the effective PII barrier; the DB-level fence ' +
          'is inert regardless). Set both before deploying.',
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
 * Cross-flag consistency for the claim-grounding family (Drift-1): a
 * WARNING, not an error — the pair is not security-relevant, but
 * EVIDENCE_FAIL_CLOSED_CAPTURE without EPISODE_SUBSTRATE_ENABLED means
 * captureTurn is a guaranteed no-op returning null, so EVERY mention
 * would be rejected 503. The operator should know before the first
 * mention bounces.
 */
function validateEvidenceGroundingEnv(env: NodeJS.ProcessEnv, warnings: string[]): void {
  if (
    envFlagEnabled(env.EVIDENCE_FAIL_CLOSED_CAPTURE) &&
    !envFlagNotDisabled(env.EPISODE_SUBSTRATE_ENABLED)
  ) {
    warnings.push(
      'EVIDENCE_FAIL_CLOSED_CAPTURE is set while EPISODE_SUBSTRATE_ENABLED is not — ' +
        'fail-closed capture requires the episode substrate; every mention will be ' +
        'rejected (503) until EPISODE_SUBSTRATE_ENABLED is turned on.',
    );
  }
}

/**
 * Cross-flag consistency for the processing lifecycle (0121): a WARNING,
 * not an error — EVIDENCE_PROCESSOR_BROKER without
 * EVIDENCE_SUBSTRATE_ENABLED means every dispatch is rejected 503 (the
 * broker requires the substrate writers for its representation output).
 * The operator should know before the first dispatch bounces — the
 * validateEvidenceGroundingEnv pair-warn mold.
 */
function validateEvidenceProcessingEnv(env: NodeJS.ProcessEnv, warnings: string[]): void {
  if (
    envFlagEnabled(env.EVIDENCE_PROCESSOR_BROKER) &&
    !envFlagNotDisabled(env.EVIDENCE_SUBSTRATE_ENABLED)
  ) {
    warnings.push(
      'EVIDENCE_PROCESSOR_BROKER is set while EVIDENCE_SUBSTRATE_ENABLED is not — ' +
        'the broker writes derived representations through the substrate seam; every ' +
        'dispatch will be rejected (503) until EVIDENCE_SUBSTRATE_ENABLED is turned on.',
    );
  }
}

/**
 * Belief serving (BELIEFS_SERVING_LANE / BELIEFS_FACT_DAMPING): damping
 * suffixes fact lines that a matched current belief contradicts — with
 * the lane off there ARE no matched beliefs, so damping-on-while-lane-off
 * is a silent no-op (the validateEvidenceProcessingEnv inconsistent-pair
 * idiom: warn, don't refuse).
 */
function validateBeliefServingEnv(env: NodeJS.ProcessEnv, warnings: string[]): void {
  if (envFlagEnabled(env.BELIEFS_FACT_DAMPING) && !envFlagEnabled(env.BELIEFS_SERVING_LANE)) {
    warnings.push(
      'BELIEFS_FACT_DAMPING is set while BELIEFS_SERVING_LANE is not — damping keys off ' +
        'the serving lane’s matched beliefs, so it is a no-op until BELIEFS_SERVING_LANE ' +
        'is turned on.',
    );
  }
}

/**
 * Raw-read gateway (MM-3): the signed-URL secret is a forgery boundary,
 * so a weak configured value is a hard boot ERROR while the gateway flag
 * is on (the RETRIEVAL_PROFILE_OVERRIDES boot-rule idiom: reject the
 * misconfiguration shape outright, don't run degraded). Flag on with NO
 * secret at all is a WARNING, not an error — streaming works without
 * one; only the mint/redeem routes refuse (503 mint, 404 redeem) until
 * the secret lands. The TTL is a positive int like the other numeric
 * knobs (validated unconditionally at the call site above).
 */
function validateEvidenceRawReadEnv(
  env: NodeJS.ProcessEnv,
  errors: string[],
  warnings: string[],
): void {
  positiveInt(env, 'EVIDENCE_SIGNED_URL_TTL_SECONDS', errors);
  if (!envFlagNotDisabled(env.EVIDENCE_RAW_READ_ENABLED)) return;
  const secret = env.EVIDENCE_SIGNED_URL_SECRET;
  if (secret === undefined || secret.trim() === '') {
    warnings.push(
      'EVIDENCE_RAW_READ_ENABLED is set without EVIDENCE_SIGNED_URL_SECRET — ' +
        'raw streaming will serve, but signed-URL mint refuses (503) and ' +
        'redeem answers 404 until a secret (>= 32 chars) is configured.',
    );
    return;
  }
  if (secret.length < 32) {
    errors.push(
      'EVIDENCE_SIGNED_URL_SECRET must be at least 32 characters while ' +
        'EVIDENCE_RAW_READ_ENABLED is on — a short secret makes minted ' +
        'raw-evidence URLs forgeable.',
    );
  }
}

/**
 * Cross-flag consistency for the evidence ingest surface (Brain v2.1
 * M3): a WARNING, not an error — the pair is not security-relevant, but
 * EVIDENCE_INGEST_ENABLED without EVIDENCE_SUBSTRATE_ENABLED means the
 * route exists while the write seam refuses every call, so EVERY ingest
 * would be rejected 503. The operator should know before the first
 * caller bounces.
 */
function validateEvidenceIngestEnv(env: NodeJS.ProcessEnv, warnings: string[]): void {
  if (
    envFlagNotDisabled(env.EVIDENCE_INGEST_ENABLED) &&
    !envFlagNotDisabled(env.EVIDENCE_SUBSTRATE_ENABLED)
  ) {
    warnings.push(
      'EVIDENCE_INGEST_ENABLED is set while EVIDENCE_SUBSTRATE_ENABLED is not — ' +
        'the ingest surface is exposed but the evidence write seam refuses every ' +
        'call; every POST /v1/ingest/evidence-asset will be rejected (503) until ' +
        'EVIDENCE_SUBSTRATE_ENABLED is turned on.',
    );
  }
}

/**
 * Cross-flag consistency for the sharing surface (Brain v2.1 MM-4): a
 * WARNING, not an error — the same shape as the ingest pair. With
 * EVIDENCE_GRANTS_API_ENABLED but no EVIDENCE_SUBSTRATE_ENABLED the
 * controller's double gate answers a bare 404 for every call (the write
 * seam would refuse anyway), so the surface looks absent while the
 * operator believes it is on. Nothing fails open — the pair is simply
 * inert, and the operator should know before the first caller bounces.
 */
function validateEvidenceGrantsApiEnv(env: NodeJS.ProcessEnv, warnings: string[]): void {
  if (
    envFlagNotDisabled(env.EVIDENCE_GRANTS_API_ENABLED) &&
    !envFlagNotDisabled(env.EVIDENCE_SUBSTRATE_ENABLED)
  ) {
    warnings.push(
      'EVIDENCE_GRANTS_API_ENABLED is set while EVIDENCE_SUBSTRATE_ENABLED is not — ' +
        'the sharing surface stays dark (its double gate answers a bare 404 for ' +
        'every grant/list/revoke) until EVIDENCE_SUBSTRATE_ENABLED is turned on.',
    );
  }
}

/**
 * Cross-flag consistency for the blob upload surface (Brain v2.1 MM-7).
 * Two WARNINGS, not errors — nothing here is a fail-open; both pairs
 * simply mean every upload bounces:
 *
 *  - without EVIDENCE_SUBSTRATE_ENABLED the write seam refuses;
 *  - without EVIDENCE_QUARANTINE the store refuses origin
 *    'external_ingest', which is the ONLY origin an upload can honestly
 *    claim (bytes crossing an HTTP boundary are external ingest). That
 *    refusal is the MM-6 fail-closed rule working as designed, so the
 *    fix is to turn the scan seam on, never to relabel the bytes.
 */
function validateEvidenceUploadEnv(env: NodeJS.ProcessEnv, warnings: string[]): void {
  if (!envFlagEnabled(env.EVIDENCE_BLOB_UPLOAD_ENABLED)) return;
  if (!envFlagNotDisabled(env.EVIDENCE_SUBSTRATE_ENABLED)) {
    warnings.push(
      'EVIDENCE_BLOB_UPLOAD_ENABLED is set while EVIDENCE_SUBSTRATE_ENABLED is not — ' +
        'the upload surface is exposed but the evidence write seam refuses every ' +
        'call; every POST /v1/ingest/evidence-blob will be rejected (503) until ' +
        'EVIDENCE_SUBSTRATE_ENABLED is turned on.',
    );
  }
  if (!envFlagEnabled(env.EVIDENCE_QUARANTINE)) {
    warnings.push(
      'EVIDENCE_BLOB_UPLOAD_ENABLED is set while EVIDENCE_QUARANTINE is not — ' +
        'uploaded bytes register as external ingest, which the store refuses ' +
        'without the quarantine seam (fail closed); every POST ' +
        '/v1/ingest/evidence-blob will be rejected (503) until ' +
        'EVIDENCE_QUARANTINE is turned on.',
    );
  }
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

/**
 * COMPACTION_TENANT_OVERRIDES — the per-tenant retention/promotion
 * schedule (Brain v2 PR8). Clones the RETRIEVAL_PROFILE_OVERRIDES shape
 * check (JSON object mapping companyId → partial override), but WARNS
 * instead of refusing to start: the parser fails open to the process
 * defaults per tenant (src/compaction/compaction-overrides.ts), so a
 * malformed value degrades to today's global schedule rather than
 * breaking boot. Per-field validation stays lenient in the parser.
 */
function validateCompactionOverridesEnv(env: NodeJS.ProcessEnv, warnings: string[]): void {
  const raw = env.COMPACTION_TENANT_OVERRIDES;
  if (raw === undefined || raw.trim() === '') return;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((o) => o === null || typeof o !== 'object' || Array.isArray(o))
    ) {
      warnings.push(
        'COMPACTION_TENANT_OVERRIDES must be a JSON object mapping ' +
          'companyId → partial compaction schedule — ignoring it (every ' +
          'tenant keeps the process-global retention/promotion defaults).',
      );
    }
  } catch (e) {
    warnings.push(
      `COMPACTION_TENANT_OVERRIDES is not valid JSON: ${(e as Error).message} — ` +
        'ignoring it (every tenant keeps the process-global ' +
        'retention/promotion defaults).',
    );
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

/** Bounded float knob (e.g. a cosine floor, which may be negative). */
// eslint-disable-next-line max-params -- validator helper family shape + explicit bounds
function floatInRange(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
  errors: string[],
): void {
  const v = env[name];
  if (v === undefined) return;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(`${name} must be a number in [${min}, ${max}]`);
  }
}
