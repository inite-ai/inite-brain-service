import { Logger } from '@nestjs/common';
import { validateEvidenceOrphanGcEnv, validateOcrEnvValues } from './evidence-flags';
// Its own statement, deliberately: this file sits at the 800-line
// god-file ceiling, and folding a third name into the import above makes
// prettier expand it to five lines. The blob-store family validates
// beside its readers like every other EVIDENCE_ knob.
import { validateEvidenceStorageEnv } from './evidence-flags';
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
  // Belief read API (Belief-B): GET /v1/beliefs and /v1/beliefs/:id over
  // the semantic_belief substrate (0120). Read-only — the promotion pass
  // stays the only writer. Default off → routes 404.
  'BELIEFS_API_ENABLED',
  // Belief serving lane: synthesize renders the caller's ACTIVE beliefs
  // as a current-state prompt section + belief-arm citations (0126;
  // repeals the 0120 shadow doctrine behind this default-off flag).
  'BELIEFS_SERVING_LANE',
  // Belief-aware fact damping (PR-B, belief-damping.ts): suffix +
  // stable demotion of fact lines a lane-matched current belief
  // contradicts, applied at the one canonical promptFactLines
  // computation. Requires BELIEFS_SERVING_LANE (inconsistent-pair WARN
  // below).
  'BELIEFS_FACT_DAMPING',
  // Belief-lane date disambiguation (memory-fitness D4): the lane
  // renders ", belief current since <day>" instead of ", as of <day>"
  // (which the generator's date block teaches as an EVENT-date stamp —
  // a belief's day is the REVISION's validFrom) and the generator's
  // belief header scopes the date. No-op without BELIEFS_SERVING_LANE.
  'BELIEFS_LANE_DATE_DISAMBIGUATION',
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
  // V13 A2: mechanical per-(entity, aspect) rollup facts at write time
  // (the MH-enumeration lever). Default off; fresh derivedVersion.
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
  // MM-zoom PR2: fragment retrieval lane — dense+BM25 over
  // derived_representation.content (0109/0124), rendered as a media-
  // evidence prompt section behind the full media fence stack (user
  // fence → media PII → 0112 consent → availability). Default off.
  'RETRIEVAL_FRAGMENT_LANE',
  // Scene lane — the episodic plane's first serving reader: BM25 over
  // memory_episode.gist (0106) scoped to the projection registry's LIVE
  // scene world, rendered as an episodic prompt section behind a
  // scoped-user-only fence stack (0117 per-member gate, fail-closed on
  // userIds IS NONE → text PII → scope tags). Default off.
  'RETRIEVAL_SCENE_LANE',
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
  // L3 anchor independence: auxiliary anchor sources consulted only
  // when zero retrieved facts name a session — BM25 episode hits /
  // fused segment hits / query-period conversations. Default off =
  // byte-identical skipped_no_anchor.
  'RETRIEVAL_L3_DIRECT_ANCHOR',
  'RETRIEVAL_L3_SEGMENT_ANCHOR',
  'RETRIEVAL_L3_TEMPORAL_ANCHOR',
  // Verified-use successor decay (0107): decay clock may restart at the
  // last VERIFIED use (memory_outcome_stat.lastVerifiedUseAt) instead
  // of the last mere retrieval. Default off.
  'RETRIEVAL_VERIFIED_USE_DECAY',
  // Verified-use successor ranking (0107): verifiedUseScore feeds a
  // saturating ranking factor (SEARCH_VERIFIED_USE_BETA). Default off.
  'RETRIEVAL_VERIFIED_USE_RANKING',
  // Tenant-aware read-time decay: half-lives resolve through the
  // per-tenant predicate registry instead of the code seed. Default off.
  'RETRIEVAL_TENANT_DECAY',
  // R3: agent-qa V2 tool set — masked search + timeline enumerator +
  // literal transcript grep in the ReAct loop.
  'AGENT_QA_TOOLS_V2',
  // Eval-harness primitives: per-call tenant override for admin keys
  // (X-Brain-Tenant) and LLM-free episode-only ingestion.
  'BRAIN_TENANT_OVERRIDE_ENABLED',
  'INGEST_EPISODE_ONLY',
  'SEARCH_PPR_ENABLED',
  'SEARCH_HNSW_ENABLED',
  // Index PROVISIONING: the schema-ready hook that gives a new tenant its
  // indexes, and the nightly sweep that reconciles the roster. Derived
  // from SEARCH_HNSW_ENABLED when unset; an explicit value overrides in
  // either direction. Counted in the engine flag budget like any other
  // HNSW_-prefixed boolean — a prefix is not a way around the budget.
  'HNSW_PROVISION_ENABLED',
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
  // Promotion consolidation gate (Brain v2 PR8): a group with sibling
  // COMPETING rows on the same (entity, predicate, user-scope) is NOT
  // folded into a summary — it aborts loudly (logger.warn) and stays for
  // the conflict engine to settle. Default off = byte-identical.
  'COMPACTION_PROMOTION_CONFLICT_GUARD',
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
  // Memory-fitness lever #1 (Design A): deterministic literal-harvest
  // lane — regex rules for ports / rate limits / HTTP statuses /
  // identifiers / naming prefixes, span-grounded by construction and
  // unioned into the closed-vocab extraction after denoise. No second
  // LLM path. Default off = byte-identical extraction.
  'EXTRACTOR_LITERAL_HARVEST',
  // Deterministic state-verb harvest lane — sibling of the literal
  // lane: a fixed past-tense transition lexicon (bought / joined /
  // quit / returned / switched to / …) harvests completed acquire/
  // dispose/change events as span-grounded `state_change` facts, with
  // pre-verb intention/negation guards. No second LLM path. Default
  // off = byte-identical extraction.
  'EXTRACTOR_STATE_VERB_HARVEST',
  // State-transition classifier (semantic stage): compromise morphology
  // finds candidate verb clauses, embedding-prototype matching (BGE-M3,
  // EN+RU bank) classifies completed-transition vs intention vs
  // unrelated. Availability gate only — NOT wired into extraction yet
  // (deliberate follow-up PR). Default off = byte-identical everything.
  'EXTRACTOR_TRANSITION_CLASSIFIER',
  'INGEST_CONTEXTUAL_FACT_EMBEDDING',
  // Humanized predicate in the fact's embedding basis (code-memory k07):
  // append "rate limit" for predicate `rate_limit` (pack `__` prefix
  // stripped, token-dedup guarded) so the vector matches natural-language
  // predicate phrasing — parity with the 0007 searchHaystack lexical
  // surface. Write-time only; default off = byte-identical.
  'INGEST_PREDICATE_INDEX_TEXT',
  'INGEST_EVENT_TIME_EXTRACTION',
  'INGEST_BATCH_EDGES',
  'INGEST_BATCH_FACTS',
  // G9 (docs/roadmap/sota-gap-build-2026-08.md): NFC-normalize + strip
  // bidi/zero-width/control chars from ingest text (mention/fact/
  // document/candidate) before storage. Default off = byte-identical.
  'INGEST_SANITIZE_UNICODE',
  // Multilingual Tier 3 (docs/roadmap/multilingual-2026-08.md). On an
  // entity-name ingest, compute a curated UTS-39-style confusables skeleton
  // (Latin↔Cyrillic↔Greek homoglyphs) + mixed-script check as a RISK SIGNAL
  // ONLY — logged for review, never blocks and never auto-merges. Default
  // off = byte-identical (no skeleton computed). ENGINE (INGEST_) prefix, so
  // this one IS on the flag budget golden (a deliberate owner decision).
  'INGEST_CONFUSABLES_CHECK',
  // Code-identifier alias resolution (k10 battery finding): a module
  // mentioned by file path and by the symbol it defines resolves to ONE
  // entity — the path↔symbol mapping is derived deterministically (no
  // embeddings, no LLM) and only a unique exact-normalized match is
  // reused, at creation time only. Default off = byte-identical.
  'INGEST_CODE_ALIAS_RESOLUTION',
  // Article-insensitive entity reuse: the canonical-name lookup is widened
  // to the leading-article variants of the name ("the office lease" ↔
  // "office lease"), so one referent coined with and without an article
  // stops splitting into two entities. Unique match only; stored names
  // never rewritten. Default off = byte-identical.
  'INGEST_ARTICLE_NORMALIZATION',
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
  // PRIVACY_ family (0117): data-protection fences, deliberately off
  // the ENGINE flag budget (they fork no engine behavior). Segment
  // fence: per-member visibility for mixed-user verbatim windows at the
  // four segment read seams, FAIL-CLOSED on un-backfilled rows — run
  // POST /v1/admin/maintenance/segments/backfill-user-ids BEFORE the
  // first enable. Off (default) → the userIds column is written but
  // never read; the seams keep their exact pre-0117 WHERE strings.
  'PRIVACY_SEGMENT_USER_FENCE',
  // Composer scope rule (deriver drop idiom): single-user insight
  // proposals get userId+scope stamped; cross-user proposals are
  // dropped. Off (default) → composed rows byte-identical.
  'PRIVACY_COMPOSER_USER_SCOPE',
  'INDEXER_WEBHOOK_PUSH_ENABLED',
  // Read-only operator view over installed indexers and their run health
  // (GET /v1/admin/indexers). Off (default) → both routes 404.
  'INDEXER_OPERATOR_VIEW_ENABLED',
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
  // Experience-memory extension (0098, bet #3 Part 3): the trajectory
  // capture surface + trajectory column read/write, on top of the
  // master. Default off ⇒ no trajectory column is written or selected
  // and the capture endpoint 404s (byte-identical to pre-0098).
  'STRATEGY_TRAJECTORIES_ENABLED',
  // Scenes shadow substrate (Brain v2 PR1, migration 0106): the batch
  // scene composer + its admin trigger. Default off ⇒ no memory_episode
  // row is ever written and the admin route 404s (byte-identical prod;
  // shadow even when on — no serving path reads the tables). SCENES_
  // family sits off the ENGINE flag budget by design (a shadow-substrate
  // builder, not an engine fork).
  'SCENES_SEGMENTATION_ENABLED',
  // Scenes: within-session topic-boundary refinement — one embedding
  // batch per conversation, the surface's only paid step. Off ⇒ the
  // segmenter is session-gap + max-turns only (embedder-free). The
  // cosine floor (SCENES_TOPIC_MIN_COSINE) is a float, not a boolean.
  'SCENES_TOPIC_BOUNDARY',
  // Scheduled scene maintenance (migration 0130): the nightly 04:20 UTC
  // cron that runs the scene chain (compose → enrich → backlink →
  // evidence links → beliefs) over the DIRTY conversations of every
  // tenant, plus the ingest-side dirty mark that feeds it. Default off ⇒
  // the cron returns before a single query and NO scene_dirty_conversation
  // row is ever written — byte-identical prod; the admin routes are the
  // only trigger, exactly as before. The budgets
  // (SCENES_MAINTENANCE_MAX_CONVERSATIONS, _TIME_BUDGET_MS) are ints, not
  // booleans.
  'SCENES_SCHEDULED_MAINTENANCE',
  // Scenes LLM enrichment (Brain v2 PR2): the optional post-swap pass —
  // ONE structured LLM call per scene replacing the deterministic gist
  // with an abstractive one and filling the full memoryValue vector +
  // stateDeltas/unexpectedDetails ('scene-scorer-llm-v1'). Default off ⇒
  // no LLM call ever runs, scenes keep the deterministic gist/score and
  // the enrich admin route 404s — byte-identical to PR1. The model knob
  // (SCENES_ENRICH_MODEL) is a string, not a boolean.
  'SCENES_LLM_ENRICHMENT',
  // Scenes fact backlink (Brain v2 PR2): reconcile each knowledge_fact's
  // source.memoryEpisodeIds to the scenes of the effective version whose
  // membership intersects its source.episodeIds, + source.sceneLinkVersion
  // (stale pointers removed; FLEXIBLE source — no migration). Nothing on
  // the serving path reads
  // the keys; they are only VISIBLE where `source` is already returned
  // verbatim (facts read/provenance API) — additive. Default off ⇒ no
  // fact row is ever touched and the backlink admin route 404s.
  'SCENES_FACT_BACKLINK',
  // Scene gist embeddings (Brain v2 PR3): the producer the 0106
  // `gistEmbedding` column never had. A post-swap encoder pass (+ POST
  // /v1/admin/maintenance/scenes/embed-gists) embeds the CANONICAL `gist`
  // text of vector-less scenes in the current world, one bounded batch per
  // run, writing the vector by primary-key UPDATE plus the fact-side
  // `embeddingSpaceId` stamp under EMBEDDING_SPACE_TRACKING. Unblocks both
  // waiting consumers: the reindex sweep (which only MOVES existing
  // vectors between spaces) and the scene lane's dense leg. Default off ⇒
  // the embedder is never called, no scene row is touched and the route
  // 404s — byte-identical prod. An embed failure is soft.
  'SCENES_GIST_EMBEDDING',
  // Scene entity links (Brain v2 PR3): resolve the enricher's free-text
  // `entityMentions` into knowledge_entity RECORD refs and persist them in
  // the 0106 `entityIds` column, through the platform's own deterministic
  // resolution (exact canonicalName/alias, INGEST_ARTICLE_NORMALIZATION
  // variants, INGEST_CODE_ALIAS_RESOLUTION path↔symbol). RESOLVE-ONLY: a
  // scene never MINTS an entity, never stamps an alias, and an unresolved
  // mention is dropped — a scene is a reconstruction, not a source of
  // truth. Fenced by #387 (a user-scoped scene links its own user's plus
  // tenant-global entities; every other scene links tenant-global only),
  // capped per scene and idempotent. `relationIds` stays unwritten — no
  // producer exists. Requires SCENES_LLM_ENRICHMENT. Default off ⇒ zero
  // resolution queries and a byte-identical SELECT/UPDATE.
  'SCENES_ENTITY_LINKS',
  // Scenes version fingerprint (Drift-3): when on, the EFFECTIVE segmenter
  // version becomes 'scene-segmenter-v1+<8-hex sha256 over the resolved
  // segmenter config>' (impl, scorer, maxTurns, topicBoundary, and — only
  // when the boundary is on — minCosine + the embedding-space id), so a
  // config change forks a NEW coexisting scene id-space instead of
  // overwriting the old world's record ids in place. Default off ⇒ the
  // literal constant version — byte-identical ids, stamps and registry
  // keys.
  'SCENES_VERSION_FINGERPRINT',
  // Pack memory projections (migration 0110), TWO producers into ONE
  // shadow world (segmenterVersion 'pack:<packId>+<fp>'):
  //   * DOCUMENT — external candidate submissions may carry
  //     scenes/stateDeltas validated against the submitting pack's
  //     manifest memoryModel (sceneSchemas / stateModels), staged as
  //     candidate kinds 'scene'/'state_delta' and projected at commit
  //     time (SceneCandidateWriterService);
  //   * CAPTURE — a mention turn matched against the installed packs'
  //     declared cues/states, model-free (no LLM, no embedding), and
  //     projected inline with a memory_episode_member edge to its L0 turn
  //     (MentionProjectionService; needs EPISODE_SUBSTRATE_ENABLED — the
  //     member edge is the projection's GDPR erasure anchor).
  // Default off ⇒ submissions carrying either array are rejected 400, no
  // such candidate row is ever written and no projection runs on either
  // path — byte-identical prod. The GDPR forget cascades for projected
  // rows run regardless — rows written while on must stay erasable.
  // PACK_ sits off the ENGINE flag budget (shadow-substrate writer, the
  // SCENES_/EVIDENCE_ precedent).
  'PACK_MEMORY_PROJECTIONS_ENABLED',
  // Source-version stamps + drift staleness. An external submission may
  // carry a `sourceVersion` ({system, ref, version, readAt}) naming the
  // revision of the external system of record it read; the stamp rides
  // candidate provenance into every committed fact's
  // source.sourceVersion, and the same submission marks the pack's
  // DERIVABLE facts (declared via memoryModel.verificationRules with
  // requires='source_version_match') whose stamp is behind that revision
  // stale, through the EXISTING 0072 staleAt/staleReason fields. Default
  // off ⇒ a submitted sourceVersion is rejected 400, no payload or fact
  // source ever gains the key, and no sweep query runs — byte-identical.
  // PACK_ sits off the ENGINE flag budget, like the projections flag
  // above.
  'PACK_SOURCE_VERSION_STALENESS',
  // Belief promotion (Belief-A, migration 0120): fold ENRICHED scenes of
  // the current effective segmenter version into the shadow
  // semantic_belief substrate via POST /v1/admin/maintenance/scenes/
  // beliefs. Default off ⇒ the route 404s and the service returns with
  // ZERO queries — no semantic_belief row is ever written
  // (byte-identical prod; shadow even when on — no serving path reads
  // the table). The corroboration floor (SCENES_BELIEF_MIN_SCENES) is an
  // int, the model knob (SCENES_BELIEF_MODEL) a string — not booleans.
  'SCENES_BELIEF_PROMOTION',
  // Belief statement synthesis (Belief-A): ONE structured LLM call per
  // belief create/revise to phrase the statement; any failure degrades
  // to the deterministic template. Default off ⇒ no LLM call ever runs —
  // every statement is the deterministic template.
  'SCENES_BELIEF_LLM_SYNTHESIS',
  // Belief negation deltas (#135 seam 1): the promotion fold admits an
  // empty-`to` / non-empty-`from` stateDelta — a state removal — as the
  // canonical sentinel value 'none' with priorValue = the delta's
  // `from`, so the supersede chain revises the belief instead of
  // silently keeping the stale assertion. Default off ⇒ empty-`to`
  // deltas are dropped exactly as before — byte-identical fold output.
  'SCENES_BELIEF_NEGATION_DELTAS',
  // Belief field fold (#135 seam 2): deterministic lexical folding of
  // enricher-re-coined field names ('car ownership' → existing 'car')
  // at promotion time — token-set subset whose extra tokens are all
  // generic modifiers; the existing name wins, ambiguity (>1 match)
  // folds nothing and warns loudly. NO embeddings, NO LLM. Default off
  // ⇒ exact-string grouping, zero extra queries — byte-identical.
  'SCENES_BELIEF_FIELD_FOLD',
  // Pack-projected state-delta promotion: the belief pass also admits
  // the `pack:<packId>+<fp>` projection worlds (0110 scene candidates,
  // both the document and the capture producer), whose deltas carry the
  // namespaced field `<packId>__<local>` and no enrichmentVersion.
  // Per-user (#387) scope, cross-pack separation and the conflict guard
  // are unchanged. Default off ⇒ the selection query, its parameters and
  // every stamp are byte-identical to the pre-flag pass — no pack scene
  // is ever seen.
  'SCENES_PACK_DELTA_PROMOTION',
  // Scene prediction baseline: the expectation snapshot the scene plane
  // never had. On, the enrichment pass loads the scene user's ACTIVE
  // semantic_belief rows (0120) BEFORE scoring, stamps them as
  // baselineRef (0106 FLEXIBLE), renders them into the prompt so
  // contradiction/unexpectedDetails are reported as DEVIATION from that
  // model (prompt scene-gist-v2), and overrides contradiction /
  // stateChange / identity in enrichedMemoryValue with a deterministic
  // no-model-call scorer (scene-scorer-v1). Mixed-user/legacy scenes get
  // NO baseline (#387 fence). Default off ⇒ zero extra queries, the
  // byte-identical scene-gist-v1 prompt and composite, no baselineRef
  // write — byte-identical rows.
  'SCENES_PREDICTION_BASELINE',
  // Memory-value promotion gate: the first consumer of the 0106 value
  // vector beyond `explicitness`. On, belief promotion drops a scene
  // whose novelty AND contradiction AND stateChange are all PRESENT and
  // all below SCENES_VALUE_GATE_MIN — "promote unless demonstrably
  // noise", so an UNDEFINED dimension promotes (unknown is not a
  // confident zero) and an unscored world behaves exactly as with the
  // gate off. Refusals are counted (skippedLowValue) and logged per
  // scene. Default off ⇒ the value dimensions are not even projected —
  // byte-identical selection, fold and rows.
  'SCENES_VALUE_GATE_ENABLED',
  // Scene evidence links (MM-zoom PR1, migration 0123): typed
  // scene-reconstructed_from->evidence_fragment|evidence_asset edges in
  // memory_support from the union of member episodes' source.evidenceRefs
  // (end of the composer run + POST /v1/admin/maintenance/scenes/
  // evidence-links). Replay-idempotent (INSERT RELATION IGNORE over
  // UNIQUE(in, out, kind)); a world without evidence refs is a graceful
  // no-op. Default off ⇒ no edge is ever written, the route 404s and the
  // composer hook is skipped — byte-identical prod. The GDPR cascades
  // erase the edges regardless — rows written while on must stay
  // erasable.
  'SCENES_EVIDENCE_LINKS',
  // Evidence substrate master (Brain v2.1 M1, migration 0109): the
  // EvidenceStoreService writers for evidence_asset / evidence_fragment /
  // derived_representation. Default off ⇒ every writer 503s and no row is
  // ever written (byte-identical prod; no serving path reads the tables
  // even when on). The GDPR cascade + retention sweep run regardless —
  // rows written while on must stay erasable. EVIDENCE_ family sits off
  // the ENGINE flag budget by design (a substrate builder, not an engine
  // fork). The fs root (EVIDENCE_FS_ROOT) is a string and the size cap
  // (EVIDENCE_MAX_BYTES) an int — not booleans. Reserved for sibling PRs
  // (none left): EVIDENCE_INGEST_ENABLED landed below (PR-C ingest
  // surface); the scene-links seam reserved here landed as
  // SCENES_EVIDENCE_LINKS — the writer is a scene pass, so it keeps the
  // SCENES_ family naming.
  'EVIDENCE_SUBSTRATE_ENABLED',
  // Fragment citations (MM-zoom PR2): generator schema gains
  // citedFragmentIds over the rendered fragment lane; resolved through
  // the rendered-set fence into fragment-arm EvidenceCitations that can
  // satisfy the 0113 capability gate for non-text. Default off =
  // byte-identical even with the lane on.
  'EVIDENCE_FRAGMENT_CITATIONS',
  // Evidence ingest surface (Brain v2.1 M3): POST /v1/ingest/evidence-asset.
  // Default off ⇒ the route answers a bare 404 (scenes-surface precedent)
  // and prod is byte-identical. Metadata-only (MM-6): originUri required,
  // no bytes, no storageRef. Requires EVIDENCE_SUBSTRATE_ENABLED to
  // actually accept writes — validateEvidenceIngestEnv warns on the
  // inconsistent pair (ingest-on/substrate-off ⇒ every call 503s).
  'EVIDENCE_INGEST_ENABLED',
  // Evidence blob upload surface (Brain v2.1 MM-7): POST
  // /v1/ingest/evidence-blob — multipart bytes → content-addressed
  // storage adapter → registerAsset(storageRef) → scan → fire-and-forget
  // broker dispatch. Default off ⇒ a bare 404 raised BEFORE the body is
  // parsed (no caller bytes buffered), byte-identical prod. Needs
  // EVIDENCE_SUBSTRATE_ENABLED and — because bytes over HTTP are
  // external ingest — EVIDENCE_QUARANTINE; validateEvidenceUploadEnv
  // warns on either inconsistent pair.
  'EVIDENCE_BLOB_UPLOAD_ENABLED',
  // Claim grounding (Drift-1, migration 0115): write-side post-resolve
  // stamp of knowledge_fact.groundingStatus; fail-closed mention capture
  // (requires EPISODE_SUBSTRATE_ENABLED — validateEvidenceGroundingEnv
  // warns on the inconsistent pair); consolidation exclude; strict
  // serving gate. All default off = byte-identical. EVIDENCE_ family
  // sits off the ENGINE flag budget by design (see above).
  'EVIDENCE_GROUNDING_STAMP',
  'EVIDENCE_FAIL_CLOSED_CAPTURE',
  'EVIDENCE_UNGROUNDED_EXCLUDE',
  'EVIDENCE_UNGROUNDED_SERVING_GATE',
  // Processing lifecycle (0121): the trusted processor broker (idempotent
  // processing_run dispatch over registered assets) and the external-
  // ingest quarantine seam (quarantineStatus stamping + scan
  // transitions). Both default off = byte-identical (broker 503s before
  // any query; quarantineStatus is never written and external_ingest is
  // rejected 503 — fail closed). The derived-output cap
  // (EVIDENCE_DERIVED_MAX_BYTES) is an int, not a boolean. EVIDENCE_
  // family sits off the ENGINE flag budget by design (see above).
  'EVIDENCE_PROCESSOR_BROKER',
  'EVIDENCE_QUARANTINE',
  // Orphan-blob GC (MM-7 follow-up): the delete-side sweep that reclaims
  // blobs no evidence_asset row references — the leak the upload path
  // creates by design (bytes are stored before their row exists, and a
  // content-addressed blob must not be unlinked on a failed
  // registration). THREE flags, deliberately staged:
  //   EVIDENCE_ORPHAN_BLOB_GC           master — the sweep exists and
  //                                     REPORTS; off = no walk, no query,
  //                                     the admin route 404s;
  //   EVIDENCE_ORPHAN_BLOB_GC_DELETE    stage two — actually unlink. Off
  //                                     = every run is a dry run whatever
  //                                     the caller asks for;
  //   EVIDENCE_ORPHAN_BLOB_GC_SCHEDULED the 04:35 UTC cron, its own
  //                                     decision (SCENES_SCHEDULED_
  //                                     MAINTENANCE idiom).
  // Deliberately NOT gated on EVIDENCE_SUBSTRATE_ENABLED: the delete side
  // never depends on the write flag. The grace window / deletion cap /
  // time budget (EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS, _MAX_DELETIONS,
  // _TIME_BUDGET_MS) are ints, not booleans. EVIDENCE_ family sits off
  // the ENGINE flag budget by design (see above).
  'EVIDENCE_ORPHAN_BLOB_GC',
  'EVIDENCE_ORPHAN_BLOB_GC_DELETE',
  'EVIDENCE_ORPHAN_BLOB_GC_SCHEDULED',
  // Local OCR processor: OcrAdapter offers the 'ocr' capability for image
  // assets (tesseract.js WASM, models read off local disk — no network,
  // ever). Default off ⇒ accepts() declines before any engine is touched
  // and the broker records the same `no installed processor` denial it
  // records today, byte-identical. It carries its own switch — unlike its
  // sibling adapters — because recognition is CPU- and memory-heavy where
  // theirs are header reads. The language set (EVIDENCE_OCR_LANGS) and
  // confidence floor (EVIDENCE_OCR_MIN_CONFIDENCE) are a string and an
  // int, not booleans (validateEvidenceOcrEnv). EVIDENCE_ family sits off
  // the ENGINE flag budget by design (see above).
  'EVIDENCE_OCR_ENABLED',
  // Representation embeddings: the write-side producer for
  // derived_representation.embedding (WRITE-DEAD since 0109), which is
  // what the fragment lane's dense leg reads. Off (default) = the
  // embedder is never called and neither embedding nor embeddingSpaceId
  // is written — byte-identical rows. EVIDENCE_ family sits off the
  // ENGINE flag budget by design (see above).
  'EVIDENCE_FRAGMENT_EMBEDDINGS',
  // Raw-read gateway (MM-3, migration 0125): the single REST surface that
  // serves original evidence bytes (stream + signed-URL mint/redeem)
  // behind the full gate ladder. Default off = every route 404s,
  // byte-identical. The secret/TTL knobs are strings/ints, not booleans
  // (validateEvidenceRawReadEnv). EVIDENCE_ family sits off the ENGINE
  // flag budget by design (see above).
  'EVIDENCE_RAW_READ_ENABLED',
  // Sharing surface (MM-4, migration 0122): the three ownership verbs
  // over an existing asset (share / list live owners / revoke). Default
  // off = every route answers a bare 404 raised in a GUARD, before the
  // global ValidationPipe could turn a malformed body into a
  // route-revealing 400 — byte-identical prod. Needs
  // EVIDENCE_SUBSTRATE_ENABLED to write (validateEvidenceGrantsApiEnv
  // warns on the inconsistent pair). EVIDENCE_ family sits off the
  // ENGINE flag budget by design (see above).
  'EVIDENCE_GRANTS_API_ENABLED',
  // EVIDENCE_S3_FORCE_PATH_STYLE is deliberately NOT here: it is
  // configuration for the object store, and validateEvidenceStorageEnv
  // hard-ERRORS on a value outside 1/0/true/false alongside the rest of
  // the EVIDENCE_S3_ family, rather than warning like an engine flag.
  // Outcome telemetry master (0107): writers append memory_outcome rows
  // + fold memory_outcome_stat counters; the nightly raw-log prune runs.
  // Default off = byte-identical (every writer is a guarded no-op).
  // OUTCOME_ prefix sits outside ENGINE_PREFIX by design — measurement
  // substrate, not an engine fork — so it is off the flag budget, like
  // the FOVEA_ family.
  'OUTCOME_TELEMETRY_ENABLED',
  // Outcome telemetry: extra gate on the high-volume `retrieved` writer
  // (one event per surfaced fact per search). Off (default) ⇒ no
  // retrieved rows even with the master on. The retention window knob
  // (OUTCOME_EVENT_RETENTION_DAYS) is an int, not a boolean flag.
  'OUTCOME_RETRIEVED_EVENTS',
  // Outcome telemetry: transactional idempotent writes — deterministic
  // record ids + INSERT IGNORE inside ONE BEGIN/COMMIT, in-tx delta
  // gating, one OCC retry. Off (default) ⇒ the legacy two-statement
  // write path runs byte-identical (pinned by the unit spec).
  'OUTCOME_TX_WRITES',
  // Decision-context telemetry (0119): content-free memory_decision rows
  // at the abstain/L3 seams + the decisionId join columns + the decision
  // prune leg. An INDEPENDENT master (the TOOL_OBSERVATIONS_ENABLED
  // precedent) — not coupled to OUTCOME_TELEMETRY_ENABLED. The retention
  // knob (OUTCOME_DECISION_RETENTION_DAYS) is an int, not a boolean flag.
  'OUTCOME_DECISION_CAPTURE',
  // Tool observations master (0111): the per-request MCP build applies
  // the innermost observation wrapper, the pack-tool proxy stamps
  // identity rows, ingest accepts toolObservationRef, the prune leg
  // runs. Default off = byte-identical (wrapper not applied). TOOL_
  // OBSERVATION_ prefix sits outside ENGINE_PREFIX by design —
  // evidence/telemetry substrate, not an engine fork — so it is off the
  // flag budget, like the OUTCOME_/FOVEA_ families.
  'TOOL_OBSERVATIONS_ENABLED',
  // Tool observations: extra opt-in gate for the ONE content-bearing
  // column (contentExcerpt, sanitized, ≤512 chars) on top of the master.
  // Off (default) ⇒ rows are digest-only, content-free by contract. The
  // retention window knob (TOOL_OBSERVATION_RETENTION_DAYS) is an int,
  // not a boolean flag.
  'TOOL_OBSERVATION_CONTENT',
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
  // Fovea optics (Optics §4.3): the subtractive lens-suppression governor —
  // for the query class, REMOVE off-task / trap-inducing lanes from the
  // effective active set before retrieval + before the answer-cache key.
  // Requires a usable per-class lens_suppression model; with none — or off,
  // or a low-confidence class match — routing is byte-identical to the static
  // lane set. Outside ENGINE_PREFIX by design (the FOVEA_ family sits off the
  // flag budget). The min-cosine floor (FOVEA_LENS_SUPPRESS_MIN_COSINE) is a
  // float, not a boolean flag.
  'FOVEA_LENS_SUPPRESS',
  // Fovea optics (verifier answer-integrity arm, Part A): after a `supported`
  // verifier verdict, run an extra LLM plausibility judge over the cited
  // premises and downgrade an implausible/out-of-context (belief-distortion)
  // answer to an abstain. Off = NO extra call, byte-identical serving. Outside
  // ENGINE_PREFIX by design (the FOVEA_ family sits off the flag budget).
  'FOVEA_PLAUSIBILITY_CHECK',
  // Fovea optics (verifier answer-integrity arm, Part C): treat a `supported`
  // answer with ZERO citations as low_coverage/abstain instead of serving an
  // uncited "supported" answer (audit F2(b)). LIVE-behavior change when on —
  // default off. Outside ENGINE_PREFIX by design (the FOVEA_ family sits off
  // the flag budget).
  'FOVEA_REQUIRE_CITATIONS',
  // Fovea serving-integrity: L3 evidence citations — the L3 transcript gains
  // per-turn [episode:...] headers and transcript-grounded claims are cited
  // as {episodeId, quote} pairs, resolved into span-verified evidence
  // citations over the stored turn text (only turns actually rendered into
  // the transcript are citable; unknown episodeIds dropped). Changes the
  // FOVEA_REQUIRE_CITATIONS verdict interaction (an episode-cited answer
  // serves). Off = prompt/schema/transcript byte-identical, no
  // evidenceCitations emitted. Outside ENGINE_PREFIX by design (the FOVEA_
  // family sits off the flag budget).
  'FOVEA_L3_EPISODE_CITATIONS',
  // Fovea serving-integrity: evidence-capability gate (0113) — a `supported`
  // answer citing a fact whose predicate requires a NON-TEXT evidence
  // capability (requiredEvidenceCapability on knowledge_predicate) abstains
  // (reason 'evidence_capability_unmet') unless cited evidence of that
  // capability exists. v1 is abstain-or-pass plumbing — every citation today
  // is text; media verifiers arrive with the M-track. Off = no registry
  // lookup, byte-identical serving. Outside ENGINE_PREFIX by design (the
  // FOVEA_ family sits off the flag budget).
  'FOVEA_EVIDENCE_CAPABILITY',
  // Fovea serving-integrity: fragment zoom (MM-zoom PR3) — ONE monotone
  // bounded zoom step at the post-verifier seam: on a verifier-fail with a
  // rendered fragment line TRUNCATED by the lane's 600-char excerpt cap,
  // fetch the fuller DERIVED TEXT of the same derived_representation rows
  // (≤2 fragments, per-fragment chars capped by the int knob
  // FOVEA_FRAGMENT_ZOOM_MAX_CHARS — not a boolean flag) through the lane's
  // own fence stack, and RE-VERIFY ONLY (never regenerate). A flipped
  // verdict serves; anything else (or any error) falls through to the
  // static downgrade unchanged. Raw bytes stay behind the
  // EVIDENCE_RAW_READ_ENABLED gateway — zoom cannot reach them. Default
  // off = verifier runs exactly once, no extra read, byte-identical
  // serving. Outside ENGINE_PREFIX by design (the FOVEA_ family sits off
  // the flag budget).
  'FOVEA_FRAGMENT_ZOOM',
  // Fovea optics: attention-hints anchor boost — on a fired L3 escalation
  // with fact anchors, the installed packs' memoryModel.attentionHints are
  // resolved against the query (case-folded literal cue match) and anchors
  // whose originating fact carries a preferred predicate get their
  // normalized score multiplied by a boost clamped to [1,2]. Ordering-only
  // (density stays the primary rank key; no anchor added/dropped); the
  // memory-model reader is consulted lazily, never when off. Default off =
  // reader unconsulted, anchor ranking byte-identical. Outside
  // ENGINE_PREFIX by design (the FOVEA_ family sits off the flag budget).
  'FOVEA_ATTENTION_HINTS',
  // Evidence plane (Brain v2 gap #5): summary-producing writers
  // (promotion, compaction rollups, recompose rewrites, arc/aggregate
  // composers) stamp the union of member source.episodeIds onto the
  // summary's source (window-deriver idiom, capped 64). Default off ⇒
  // every summary write byte-identical. Outside ENGINE_PREFIX by design
  // (the PROVENANCE_ family is a provenance surface, not an engine
  // fork — sits off the flag budget like FOVEA_/MULTILINGUAL_).
  'PROVENANCE_SUMMARY_EPISODE_STAMP',
  // Evidence plane (Brain v2 gap #6): GET /v1/facts/:id/provenance runs
  // a bounded recursive derivedFrom closure and serves the episode union
  // + derivedFacts/closure fields. Member fences silently drop
  // (filtered marker); root 404 semantics unchanged. Default off ⇒
  // response byte-identical. The depth/fact/episode caps
  // (PROVENANCE_CLOSURE_MAX_*) are integer knobs, not boolean flags.
  // Outside ENGINE_PREFIX by design — off the flag budget.
  'PROVENANCE_RECURSIVE_CLOSURE',
  // Typed support graph, write side (Drift-5, 0116): writers emit
  // canonical memory_support edges — scene-backlink supported_by
  // (alongside the legacy stamps), conflict resolver contradicted_by,
  // promotion/compaction/recompose derived_from mirrors. GDPR cascades
  // erase edges regardless of this flag. Default off ⇒ no edge written,
  // every writer byte-identical. Outside ENGINE_PREFIX by design (the
  // PROVENANCE_ family sits off the flag budget).
  'PROVENANCE_SUPPORT_EDGES',
  // Typed support graph, read side (Drift-5): the recursive closure
  // additionally follows derived_from edges and serves the crossed
  // edges as the optional supportEdges field. Default off ⇒ walk and
  // response byte-identical (field absent). Outside ENGINE_PREFIX by
  // design — off the flag budget.
  'PROVENANCE_SUPPORT_GRAPH_READ',
  // Evidence plane: the one-hop GET /v1/facts/:id/provenance read
  // widens to the ±radius sibling turns of the same conversation around
  // each primary grounding turn (radius =
  // PROVENANCE_EPISODE_NEIGHBOUR_RADIUS, an integer knob clamped 1..3;
  // union capped by PROVENANCE_CLOSURE_MAX_EPISODES). Neighbours pass
  // the identical episode read fences as the primary fetch and carry
  // relation:'neighbour'. Default off ⇒ response byte-identical.
  // Outside ENGINE_PREFIX by design — the PROVENANCE_ family sits off
  // the flag budget.
  'PROVENANCE_EPISODE_NEIGHBOURS',
  // Multilingual Tier 1 (migration 0100). Confidence-aware attribution:
  // the detector returns `und` (not `en`) for short/stopword-less objects
  // and the resolver stamps langConfidence/langSource/detectorVersion/
  // sourceLang. Default off ⇒ Phase-4 `en` fallback, no new fields written.
  // Outside ENGINE_PREFIX by design (a cross-cutting locale concern, not an
  // engine fork — sits off the flag budget alongside the FOVEA_ family).
  'MULTILINGUAL_LANG_ATTRIBUTION',
  // Multilingual Tier 1. Soft same-language filter: the hard
  // `lang = q OR lang IS NONE` retrieval/profile exclusion becomes a
  // confidence-gated ranking boost (cross-lingual facts demoted, never
  // hidden). Default off ⇒ the hard filter is byte-identical.
  'MULTILINGUAL_SOFT_LANG_FILTER',
  // Multilingual Tier 1. Confidence gate on the HARD same-language search
  // exclusion: a query language below the high-confidence floor (incl. the
  // zero-evidence `en` fallback on stopword-less identifier queries) runs a
  // single unfiltered pass instead of excluding other-language facts (the
  // code-memory k07 miss). Default off ⇒ any non-`und` detection filters,
  // byte-identical. MULTILINGUAL_ family, off the ENGINE flag budget.
  'MULTILINGUAL_LANG_FILTER_CONFIDENCE_GATE',
  // Multilingual Tier 1. Write-side mirror of the hard-filter gate
  // (migration 0127): a detection below the same shared high-confidence
  // floor is not stamped as the row's authoritative `lang` (fact-resolver +
  // derive-row-builder); the detected script and — on the resolver path —
  // the attribution metadata (detectedLang/langConfidence/detectorVersion)
  // are still recorded, and inherited/explicit language paths are
  // untouched. Default off ⇒ any non-`und` detection stamps,
  // byte-identical. MULTILINGUAL_ family, off the ENGINE flag budget.
  'MULTILINGUAL_LANG_STAMP_CONFIDENCE_GATE',
  // Multilingual Tier 3 (migration 0102). Reversible entity resolution: a
  // weak embedding-only inline-resolution match is NOT auto-merged — it
  // becomes a reviewable entity_merge_log candidate — and every strong
  // (exact/externalRef) reuse writes an auditable merge row so a wrong fuse
  // can be found and split. Default off ⇒ immediate reuse, no log (byte-
  // identical). MULTILINGUAL_ family, off the ENGINE flag budget.
  'MULTILINGUAL_ENTITY_REVERSIBLE',
  // Multilingual Tier 3. CJK segmentation: the mention-scan topic is
  // segmented with the Intl.Segmenter built-in (ICU-backed, no new dep) so
  // CJK / non-space-delimited scripts yield real terms instead of being
  // split to nothing. Resolved into the RetrievalProfile (cjkSegmentation).
  // Default off ⇒ the legacy split (byte-identical). MULTILINGUAL_ family,
  // off the ENGINE flag budget.
  'MULTILINGUAL_CJK_SEGMENTATION',
  // Multilingual Tier 4. Language-agnostic lane classifier: a nearest-centroid
  // classifier (multilingual exemplar centroids, shared cosine primitive)
  // AUGMENTS the English-regex answer router for queries it returns
  // null/generic for — abstain-safe. Resolved into the RetrievalProfile
  // (multilingualLaneRouting) and threaded to the synthesize boundary. Default
  // off ⇒ the regex router is byte-identical. MULTILINGUAL_ family, off the
  // ENGINE flag budget.
  'MULTILINGUAL_LANE_ROUTING',
  // Multilingual Tier 4. Locale-time decomposition: ar/hi/ko relative-
  // expression recognition (chrono has no parser for them), locale-aware digit
  // parsing, and the atUtcMidnight day-shift fix (anchors a relative event to
  // the speaker's LOCAL calendar day via dto.timezone). Read on the ingest
  // path (mention-persist); re-ingest to apply. Default off ⇒ byte-identical
  // UTC-day chrono behavior. MULTILINGUAL_ family, off the ENGINE flag budget.
  'MULTILINGUAL_TEMPORAL',
  // Multilingual Tier 4. Typed conflict detection: detectEvidenceConflicts
  // compares normalized TYPED values (numbers/booleans, digit-script/case
  // folded) instead of surface strings, catching cross-lingual value conflicts
  // on typed slots. Presentation of already-COMPETING facts only, never the
  // write-side adjudicator. Resolved into the RetrievalProfile
  // (multilingualConflict). Default off ⇒ byte-identical string-equality.
  // MULTILINGUAL_ family, off the ENGINE flag budget.
  'MULTILINGUAL_CONFLICT',
  // Multilingual Tier 5 (migration 0103). Hierarchical per-language focus
  // calibration: the §4.2 per-class isotonic calibrator gains a LANGUAGE key
  // with an exact (class × language) → (class × script/family) → (class)
  // fallback, and the focus-signal capture stamps the detected query
  // language/script per sample. Read at fit/load time via fovea-flags
  // (multilingualCalibrationEnabled). Serving-neutral (nothing on the answer
  // path reads the calibration yet). Default off ⇒ language dimension never
  // written or consulted; global per-class calibration byte-identical.
  // MULTILINGUAL_ family, off the ENGINE flag budget.
  'MULTILINGUAL_CALIBRATION',
  // Multilingual Tier 5. Answer-language guard: the answer target follows a
  // strict fallback order (explicit answerLang → session locale → confidently-
  // detected query language → no forced language) so the facts never pick the
  // answer language, and the generated answer's own language is checked against
  // that target with ONE bounded corrective regeneration on a cross-script
  // mismatch. Resolved into the RetrievalProfile (answerLangGuard). Default off
  // ⇒ resolveAnswerLang byte-identical, no output-language check.
  // MULTILINGUAL_ family, off the ENGINE flag budget.
  'MULTILINGUAL_ANSWER_GUARD',
  // Multilingual Tier 2 (migration 0101). The embedding-space family stamps
  // + guards the (model, dim, norm) space a vector lives in so flipping the
  // embedder can't silently mix vector spaces. All default off; each is a
  // cross-cutting embedding concern (EMBEDDING_ prefix), so — like the
  // MULTILINGUAL_ / FOVEA_ families — it sits OFF the ENGINE flag budget.
  //
  // Stamp `embeddingSpaceId` on rewrite (reindex sweep). Off ⇒ no column
  // written, serving byte-identical.
  'EMBEDDING_SPACE_TRACKING',
  // Default-ON strict-space serving guard: refuse a query embedded in a space
  // incompatible with the target rows (no cross-space cosine, no warmup
  // failover across incompatible dims). Explicit 0/false opts into unsafe
  // legacy read fallback; durable writes remain guarded unconditionally.
  'EMBEDDING_SPACE_STRICT',
  // Shadow dual-write: arm a migration to write BOTH the active and the
  // target space. Off ⇒ no target-space write is armed.
  'EMBEDDING_SPACE_DUAL_WRITE',
  // Per-tenant active-space selection + atomic cutover. Off ⇒ reads use the
  // current provider space and the cutover admin surface refuses.
  'EMBEDDING_SPACE_ACTIVE',
  // Per-user read scope on the two pre-0055 read surfaces (entity
  // timeline + competing facts): on + userId, the hardcoded
  // `userId IS NONE` fence widens to `(userId IS NONE OR userId =
  // $scopeUserId)` with the caller-asserted id pinned to a user-bound
  // token's end-user (pinUserScope). Off (default) ⇒ the historical
  // clause, byte-identical. READ_ sits off the ENGINE flag budget by
  // design (an authz read fence, not an engine fork).
  'READ_SURFACE_USER_SCOPE',
  // Direct-fact conflict semantics: the typed ingest path promotes an
  // unknown-predicate (registry '__default__' fallback) fact from
  // append_only to 'bitemporal' in FactResolverService so same-slot
  // direct writes can SUPERSEDE/COMPETE instead of always INSERTED.
  // Mention-path bulk and DEFAULT_FALLBACK itself untouched. Off
  // (default) ⇒ append_only passthrough, byte-identical. CONFLICT_
  // sits off the ENGINE flag budget by design (resolver-policy knob
  // family, not an engine fork).
  'CONFLICT_DIRECT_FACT_SLOT',
  // Mention-path sibling: the extraction path promotes a 'single_active'
  // registry policy (whose resolver branch supersedes unconditionally
  // and can never form a COMPETING pair) to 'bitemporal' in
  // FactResolverService, so contradictory slot values from two
  // conversations COMPETE instead of the second silently replacing the
  // first. append_only bulk / DEFAULT_FALLBACK / direct path untouched.
  // Off (default) ⇒ registry passthrough, byte-identical.
  'CONFLICT_MENTION_FACT_SLOT',
  // Write-side slot canonicalization: a mention-path fact whose
  // predicate has a declared canonical alias (duration_limit → status)
  // AND whose object carries an explicit calendar anchor (full month
  // name + year, or ISO date) resolves in the canonical single-value
  // slot, so cross-predicate contradictions about one attribute meet in
  // one (userId, entity, predicate) slot and the normal
  // single_active/bitemporal machinery sees the collision. Static
  // table + regex — no DB read, no fuzzy matching. Bare unit durations
  // ("30 days"), the direct typed path, and every other predicate are
  // untouched. Off (default) ⇒ extracted-predicate passthrough,
  // byte-identical.
  'CONFLICT_SLOT_CANONICALIZATION',
  // Succession tiebreaker for the bitemporal close-margin doctrine
  // (migration 0129): a close-margin write attesting succession —
  // mention path: a deterministic cue regex over the object ("is now
  // X", "moves from A to B", "instead of", "no longer"); direct path:
  // a typed slot re-write is a self-update by the act unless the claim
  // cites an external artifact (document/url evidence) — CLOSES pool
  // members with a strictly-earlier-beyond-window validFrom as
  // superseded history instead of flipping them to COMPETING; stuck
  // COMPETING rows are re-admitted for exactly these calls (0085-F3
  // doctrine) and an exact same-origin restatement corroborates
  // instead of dueling. Score margin alone cannot tell a temporal
  // UPDATE from a CONTRADICTION, and the measured batteries show
  // validFrom separation and origin identity cannot either. Cue-less
  // writes (contradiction arms), same-stamp pairs and artifact-backed
  // incumbents keep the existing doctrine. Window:
  // CONFLICT_TEMPORAL_TIEBREAK_WINDOW_MS (default 0 = strict event
  // order, clamped to [0, 365d]). Off (default) ⇒ the fn's new option
  // args are never bound, byte-identical.
  'CONFLICT_TEMPORAL_TIEBREAKER',
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
