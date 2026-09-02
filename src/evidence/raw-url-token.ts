import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed raw-evidence URL token (Brain v2.1 MM-3) — the pure half of
 * the mint/redeem contract: `base64url(JSON payload) + '.' +
 * HMAC-SHA256-hex over the base64url payload`, keyed by
 * EVIDENCE_SIGNED_URL_SECRET. Kept free of Nest/DB imports so both the
 * controller and the read service (and the unit spec) share one
 * implementation.
 */

/** Payload (v1). Field names are single letters on purpose — the token
 *  rides in a URL path; every byte counts. */
export interface EvidenceTokenPayload {
  v: 1;
  /** companyId — the tenant the redeem is structurally pinned to. */
  t: string;
  /** evidence_asset record id (string form). */
  a: string;
  /** evidence_fragment record id when minted off the fragment twin. */
  f?: string;
  /** keyHash of the MINTING credential — redeem audit attribution. */
  k: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

export function mintEvidenceToken(payload: EvidenceTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

export type EvidenceTokenVerdict =
  /** Malformed or bad signature — the payload is NOT trustworthy. */
  | { state: 'invalid' }
  /** Signature checks out but the token is past its exp. */
  | { state: 'expired'; payload: EvidenceTokenPayload }
  | { state: 'valid'; payload: EvidenceTokenPayload };

/**
 * Verify a token. Signature FIRST (timing-safe), shape second, expiry
 * last — a caller must never act on any field of an unsigned payload
 * (the redeem route writes audit rows into the payload's tenant, so a
 * forged tenant must die before any DB touch).
 */
export function verifyEvidenceToken(
  token: string,
  secret: string,
  nowMs: number,
): EvidenceTokenVerdict {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    return { state: 'invalid' };
  }
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { state: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { state: 'invalid' };
  }
  const p = parsed as Record<string, unknown>;
  if (
    p === null ||
    typeof p !== 'object' ||
    p.v !== 1 ||
    typeof p.t !== 'string' ||
    typeof p.a !== 'string' ||
    typeof p.k !== 'string' ||
    (p.f !== undefined && typeof p.f !== 'string') ||
    typeof p.exp !== 'number' ||
    !Number.isFinite(p.exp)
  ) {
    return { state: 'invalid' };
  }
  const payload = parsed as EvidenceTokenPayload;
  if (payload.exp * 1000 <= nowMs) return { state: 'expired', payload };
  return { state: 'valid', payload };
}
