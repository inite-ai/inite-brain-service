import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CredentialCipherError, credentialKeys } from '../../common/secret-cipher';

/**
 * The webhook address — the one path segment a vendor is given
 * (`POST /v1/source-connections/webhook/<address>`). The public route
 * has no brain credential and no tenant in its URL, so the address
 * carries both: `<companyId>.<connection tail>.<sig>` in base64url,
 * the signature an HMAC-SHA256 under the credential key (the OAuth
 * `state` mold) — a forged or edited address opens no tenant, and the
 * signature fails before any query. The address identifies; the
 * connection's webhook secret (or the vendor's own signature)
 * authenticates — two different things, rotated separately.
 */

const SIG_BYTES = 16;
const COMPANY = /^[A-Za-z0-9_-]{1,64}$/;
const TAIL = /^[A-Za-z0-9_]{1,64}$/;

function addressKey(): Buffer {
  const [key] = credentialKeys();
  if (!key) throw new CredentialCipherError('SOURCE_CREDENTIAL_ENCRYPTION_KEY is unset');
  return createHash('sha256').update('source-webhook-address').update(key).digest();
}

function signatureOf(companyId: string, tail: string): Buffer {
  return createHmac('sha256', addressKey())
    .update(`${companyId}.${tail}`)
    .digest()
    .subarray(0, SIG_BYTES);
}

export function signAddress(companyId: string, tail: string): string {
  if (!COMPANY.test(companyId) || !TAIL.test(tail)) {
    throw new Error('webhook address: invalid company id or connection tail');
  }
  const sig = signatureOf(companyId, tail).toString('base64url');
  return Buffer.from(`${companyId}.${tail}.${sig}`, 'utf8').toString('base64url');
}

/** The tenant and connection an address names, or null for anything not signed under this deployment's key. */
export function verifyAddress(address: string): { companyId: string; tail: string } | null {
  if (typeof address !== 'string' || address.length === 0 || address.length > 512) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(address, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // Canonical spelling only — base64url decodes a dangling character leniently.
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== address) return null;
  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [companyId, tail, sig] = parts as [string, string, string];
  if (!COMPANY.test(companyId) || !TAIL.test(tail)) return null;
  let expected: Buffer;
  try {
    expected = signatureOf(companyId, tail);
  } catch {
    return null;
  }
  const given = Buffer.from(sig, 'base64url');
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) return null;
  return { companyId, tail };
}
