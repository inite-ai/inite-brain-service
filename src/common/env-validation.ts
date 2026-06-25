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
  required(env, 'SURREALDB_URL', errors, /^(ws|wss|http|https):\/\//);
  required(env, 'SURREALDB_USERNAME', errors);
  required(env, 'SURREALDB_PASSWORD', errors);
  required(env, 'OPENAI_API_KEY', errors, /^sk-/);

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
  if (isProd && env.THROTTLE_DISABLED === '1') {
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
function validateBodySize(env: NodeJS.ProcessEnv, errors: string[]): void {
  const maxBody = env.MAX_BODY_SIZE;
  if (maxBody !== undefined && !/^\d+(\.\d+)?(b|kb|mb)?$/i.test(maxBody.trim())) {
    errors.push(
      'MAX_BODY_SIZE must be a byte count or a b/kb/mb size (e.g. "1mb", ' +
        '"512kb", "1048576") — gb/tb and other units are rejected.',
    );
  }
}

function required(
  env: NodeJS.ProcessEnv,
  name: string,
  errors: string[],
  pattern?: RegExp,
): void {
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
