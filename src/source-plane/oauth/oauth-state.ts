import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CredentialCipherError, credentialKeys } from '../credential-cipher';

/**
 * The OAuth `state` — self-authenticating: `<companyId>.<nonce>.<sig>`
 * in base64url, the signature an HMAC-SHA256 under the credential key,
 * so the PUBLIC callback never opens (nor provisions) a tenant for a
 * forged value — the signature fails before any query.
 */
const STATE_SIG_BYTES = 16;

function stateKey(): Buffer {
  const [key] = credentialKeys();
  if (!key) throw new CredentialCipherError('SOURCE_CREDENTIAL_ENCRYPTION_KEY is unset');
  return createHash('sha256').update('source-oauth-state').update(key).digest();
}

/** `<companyId>.<nonce>.<sig>` — base64url; the signature binds the tenant so a forged state opens nothing. */
export function signState(companyId: string, nonce: string): string {
  const sig = createHmac('sha256', stateKey())
    .update(`${companyId}.${nonce}`)
    .digest()
    .subarray(0, STATE_SIG_BYTES)
    .toString('base64url');
  return Buffer.from(`${companyId}.${nonce}.${sig}`, 'utf8').toString('base64url');
}

export function verifyState(state: string): { companyId: string; nonce: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(state, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // Canonical form only: base64url decodes a dangling character leniently,
  // and a non-canonical spelling of a valid state must not spend it.
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== state) return null;
  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [companyId, nonce, sig] = parts as [string, string, string];
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(companyId) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
    return null;
  let expected: Buffer;
  try {
    expected = createHmac('sha256', stateKey())
      .update(`${companyId}.${nonce}`)
      .digest()
      .subarray(0, STATE_SIG_BYTES);
  } catch {
    return null;
  }
  const given = Buffer.from(sig, 'base64url');
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) return null;
  return { companyId, nonce };
}
