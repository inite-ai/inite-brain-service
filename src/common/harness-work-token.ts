import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { credentialKeys } from './secret-cipher';

/**
 * The harness work token (#819): what `take_memory_work` hands the agent
 * and `submit_memory_work` takes back. `base64url(JSON payload) + '.'
 * + base64url(HMAC-SHA256)` — the raw-evidence URL token mold. It binds the
 * tenant, the user scope, the kind of work and exactly what was handed out
 * (documents and their claimed runs, the ids behind every memory handle
 * the prompt showed, the pairs or scenes asked about and the evidence
 * signature each was asked on), so a submission can only land on what the
 * server issued, in the tenant that issued it. Nothing is rebuilt from
 * process state at submit — any replica accepts it.
 *
 * The key is derived from the credential key (SOURCE_CREDENTIAL_ENCRYPTION_KEY,
 * the webhook-address and OAuth-state key), else FORGET_HMAC_KEY, each
 * domain-separated; with neither set, a per-process random key — tokens
 * then do not survive a restart or cross replicas (a submit there is
 * refused and the work is simply taken again). No new secret.
 */
/**
 * The kinds of deferred work a connected agent can take, in the order
 * they are offered. Attribute classification comes before extraction: a
 * predicate a direct write coined waits as append_only until classified,
 * and a fact extracted under it meanwhile is resolved by that default —
 * on the memory-fitness run, extraction went first and every revision
 * of `queue_backend` / `deploy_target` / `pilot_launch_date` stayed
 * current beside the value it replaced. Classifying is one short batch.
 */
export const HARNESS_WORK_KINDS = [
  'predicate_semantics',
  'extraction',
  'fact_resolution',
  'entity_match',
  'fact_conflict',
  'fact_corroboration',
  'scene_summary',
  'belief_statement',
] as const;
export type HarnessWorkKind = (typeof HARNESS_WORK_KINDS)[number];

interface TokenBase {
  v: 2;
  t: HarnessWorkKind;
  /** companyId. */
  c: string;
  /** The pinned user scope, absent for tenant-global work. */
  u?: string;
  /** Nonce: one submission in flight per token. */
  n: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

export interface ExtractionTokenPayload extends TokenBase {
  t: 'extraction';
  /** Document ids, in group order. */
  d: string[];
  /** Their claimed run ids, same order. */
  r: string[];
  /** Predicate vocabulary hash the prompt was built from. */
  h: string;
  /** The circle key the group was said in ('' for none). */
  k: string;
  /** The record ids behind the prompt's handles: e(N) = e[N-1], m(N) = m[N-1]. */
  x: { e: string[]; m: string[] };
}

export interface PairsTokenPayload extends TokenBase {
  t: 'entity_match' | 'fact_conflict' | 'fact_corroboration';
  /** [a, b, evidence signature] per pair, in prompt order (p1, p2, …). */
  p: Array<[string, string, string]>;
}

export interface ScenesTokenPayload extends TokenBase {
  t: 'scene_summary';
  /** Scene ids, in prompt order (s1, s2, …). */
  s: string[];
  /** The enrichment revision the prompt was built for. */
  ev: string;
}

export interface PredicatesTokenPayload extends TokenBase {
  t: 'predicate_semantics';
  /** Predicate ids, in prompt order (q1, q2, …). */
  q: string[];
}

export interface BeliefsTokenPayload extends TokenBase {
  t: 'belief_statement';
  /** [belief id, signature of what it states] per belief, in prompt order (b1, b2, …). */
  b: Array<[string, string]>;
}

export interface ResolutionTokenPayload extends TokenBase {
  t: 'fact_resolution';
  /** [fact id, candidate ids in prompt order, signature of what was shown] per item (r1, r2, …). */
  f: Array<[string, string[], string]>;
}

export type WorkTokenPayload =
  | ExtractionTokenPayload
  | ResolutionTokenPayload
  | PairsTokenPayload
  | ScenesTokenPayload
  | PredicatesTokenPayload
  | BeliefsTokenPayload;

/** Longest token accepted: 64 documents and every memory handle fit well inside. */
export const WORK_TOKEN_MAX_CHARS = 32_768;

export type WorkTokenVerdict =
  | { state: 'invalid' }
  | { state: 'expired'; payload: WorkTokenPayload }
  | { state: 'valid'; payload: WorkTokenPayload };

let processKey: Buffer | undefined;

function tokenKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  let base: Buffer | undefined;
  try {
    base = credentialKeys(env)[0];
  } catch {
    base = undefined;
  }
  const forget = env.FORGET_HMAC_KEY?.trim();
  if (!base && forget) base = Buffer.from(forget, 'utf8');
  if (!base) {
    if (!processKey) {
      processKey = randomBytes(32);
      new Logger('HarnessWorkToken').warn(
        'no SOURCE_CREDENTIAL_ENCRYPTION_KEY or FORGET_HMAC_KEY: harness work tokens use a per-process key',
      );
    }
    base = processKey;
  }
  return createHash('sha256').update('harness-extraction-work').update(base).digest();
}

function sign(body: string, env?: NodeJS.ProcessEnv): string {
  return createHmac('sha256', tokenKey(env)).update(body).digest('base64url');
}

export function mintWorkToken(payload: WorkTokenPayload, env?: NodeJS.ProcessEnv): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, env)}`;
}

export function verifyWorkToken(
  token: unknown,
  now: number = Date.now(),
  env?: NodeJS.ProcessEnv,
): WorkTokenVerdict {
  if (typeof token !== 'string' || token.length === 0 || token.length > WORK_TOKEN_MAX_CHARS) {
    return { state: 'invalid' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { state: 'invalid' };
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(body, env), 'base64url');
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) {
    return { state: 'invalid' };
  }
  let payload: WorkTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as WorkTokenPayload;
  } catch {
    return { state: 'invalid' };
  }
  if (
    payload?.v !== 2 ||
    !(HARNESS_WORK_KINDS as readonly string[]).includes(payload.t) ||
    typeof payload.c !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.exp !== 'number' ||
    !wellFormed(payload)
  ) {
    return { state: 'invalid' };
  }
  if (now / 1000 > payload.exp) return { state: 'expired', payload };
  return { state: 'valid', payload };
}

function wellFormed(p: WorkTokenPayload): boolean {
  switch (p.t) {
    case 'extraction':
      return (
        Array.isArray(p.d) &&
        Array.isArray(p.r) &&
        p.d.length > 0 &&
        p.d.length === p.r.length &&
        Array.isArray(p.x?.e) &&
        Array.isArray(p.x?.m)
      );
    case 'entity_match':
    case 'fact_conflict':
    case 'fact_corroboration':
      return tuples(p.p, 3);
    case 'fact_resolution':
      return tuples(p.f, 3) && p.f.every((x) => Array.isArray(x[1]));
    case 'scene_summary':
      return Array.isArray(p.s) && p.s.length > 0 && typeof p.ev === 'string';
    case 'predicate_semantics':
      return Array.isArray(p.q) && p.q.length > 0 && p.q.every((x) => typeof x === 'string');
    case 'belief_statement':
      return tuples(p.b, 2);
  }
}

/** A non-empty array of fixed-length tuples. */
function tuples(xs: unknown, length: number): boolean {
  return (
    Array.isArray(xs) &&
    xs.length > 0 &&
    xs.every((x) => Array.isArray(x) && (x as unknown[]).length === length)
  );
}
