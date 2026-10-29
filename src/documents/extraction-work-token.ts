import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { credentialKeys } from '../common/secret-cipher';

/**
 * The harness work token (#819): what `take_extraction_work` hands the
 * agent and `submit_extraction` takes back. `base64url(JSON payload) + '.'
 * + base64url(HMAC-SHA256)` — the raw-evidence URL token mold. It binds the
 * tenant, the user scope, the documents and their claimed runs, the
 * predicate vocabulary and the memory the prompt was built from, so a
 * submission can only land on text the server handed out, in the tenant
 * that handed it out. No lease table: the claimed runs are the lease
 * (indexer_run `running`), and the token expires before the run ledger's
 * stale window reclaims them (extraction-work.service.ts).
 *
 * The key is derived from the credential key (SOURCE_CREDENTIAL_ENCRYPTION_KEY,
 * the webhook-address and OAuth-state key), else FORGET_HMAC_KEY, each
 * domain-separated; with neither set, a per-process random key — tokens
 * then do not survive a restart or cross replicas (a submit there is
 * refused and the claim recovers through the stale window). No new secret.
 */
export interface WorkTokenPayload {
  v: 1;
  /** companyId. */
  c: string;
  /** The pinned user scope, absent for tenant-global work. */
  u?: string;
  /** Document ids, in group order. */
  d: string[];
  /** Their claimed run ids, same order. */
  r: string[];
  /** Predicate vocabulary hash the prompt was built from. */
  h: string;
  /** Digest of the memory context the prompt carries. */
  m: string;
  /** The circle key the group was said in ('' for none). */
  k: string;
  /** Nonce: keys the in-process prepared context. */
  n: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

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
      new Logger('ExtractionWorkToken').warn(
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
  if (typeof token !== 'string' || token.length === 0 || token.length > 16_384) {
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
    payload?.v !== 1 ||
    typeof payload.c !== 'string' ||
    !Array.isArray(payload.d) ||
    !Array.isArray(payload.r) ||
    payload.d.length !== payload.r.length ||
    payload.d.length === 0 ||
    typeof payload.exp !== 'number'
  ) {
    return { state: 'invalid' };
  }
  if (now / 1000 > payload.exp) return { state: 'expired', payload };
  return { state: 'valid', payload };
}
