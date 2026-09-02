/**
 * Pure helpers of the raw-read gateway (MM-3): the signed-URL token
 * (mint/verify round-trip, forgery/expiry/shape rejection) and the
 * strictest fragment+asset piiClasses union. The full ladder is covered
 * by test/evidence-raw-gateway.e2e-spec.ts against a real SurrealDB.
 */
import {
  EvidenceTokenPayload,
  mintEvidenceToken,
  verifyEvidenceToken,
} from '../src/evidence/raw-url-token';
import { strictestPiiUnion } from '../src/common/media-pii';

const SECRET = 's'.repeat(32);
const NOW = 1_760_000_000_000; // arbitrary fixed instant (ms)

const payload = (over: Partial<EvidenceTokenPayload> = {}): EvidenceTokenPayload => ({
  v: 1,
  t: 'co_token_unit',
  a: 'evidence_asset:abc123',
  k: 'sha256:deadbeef',
  exp: Math.floor(NOW / 1000) + 300,
  ...over,
});

describe('evidence signed-URL token', () => {
  it('round-trips: mint → verify yields the exact payload', () => {
    const p = payload({ f: 'evidence_fragment:frag1' });
    const token = mintEvidenceToken(p, SECRET);
    // URL-path-safe by construction: base64url + '.' + lowercase hex.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    const v = verifyEvidenceToken(token, SECRET, NOW);
    expect(v).toEqual({ state: 'valid', payload: p });
  });

  it('rejects a tampered payload as invalid (signature, not expiry)', () => {
    const token = mintEvidenceToken(payload(), SECRET);
    const [body, sig] = token.split('.') as [string, string];
    const other = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    other.t = 'co_other_tenant'; // retarget the tenant, keep the old sig
    const forged = `${Buffer.from(JSON.stringify(other)).toString('base64url')}.${sig}`;
    expect(verifyEvidenceToken(forged, SECRET, NOW)).toEqual({ state: 'invalid' });
  });

  it('rejects a token minted under a different secret', () => {
    const token = mintEvidenceToken(payload(), 'x'.repeat(32));
    expect(verifyEvidenceToken(token, SECRET, NOW)).toEqual({ state: 'invalid' });
  });

  it.each([
    ['no dot', 'nodothere'],
    ['empty body', '.abc'],
    ['empty sig', 'abc.'],
    ['two dots', 'a.b.c'],
    ['non-json body', `${Buffer.from('not json').toString('base64url')}.x`],
  ])('malformed token (%s) is invalid, never a throw', (_name, raw) => {
    expect(verifyEvidenceToken(raw, SECRET, NOW)).toEqual({ state: 'invalid' });
  });

  it('wrong payload shape is invalid even with a VALID signature', () => {
    // Signature checks out but v/exp/t are wrong — shape must still deny.
    const bad = { v: 2, t: 't', a: 'a', k: 'k', exp: 1 } as unknown as EvidenceTokenPayload;
    const token = mintEvidenceToken(bad, SECRET);
    expect(verifyEvidenceToken(token, SECRET, NOW)).toEqual({ state: 'invalid' });
  });

  it('an expired token verifies its signature and reports expired WITH the payload', () => {
    // The redeem route needs the trusted payload to write the
    // denied_expired audit row into the right tenant.
    const p = payload({ exp: Math.floor(NOW / 1000) - 1 });
    const v = verifyEvidenceToken(mintEvidenceToken(p, SECRET), SECRET, NOW);
    expect(v).toEqual({ state: 'expired', payload: p });
  });

  it('exp is compared in seconds against a ms clock (boundary exact)', () => {
    const exp = Math.floor(NOW / 1000);
    const token = mintEvidenceToken(payload({ exp }), SECRET);
    expect(verifyEvidenceToken(token, SECRET, exp * 1000).state).toBe('expired');
    expect(verifyEvidenceToken(token, SECRET, exp * 1000 - 1).state).toBe('valid');
  });
});

describe('strictestPiiUnion (fragment + parent asset)', () => {
  it('unclassified on EITHER side wins (undefined out — blocked)', () => {
    expect(strictestPiiUnion(undefined, [])).toBeUndefined();
    expect(strictestPiiUnion([], null)).toBeUndefined();
    expect(strictestPiiUnion(null, undefined)).toBeUndefined();
    expect(strictestPiiUnion(['face'], undefined)).toBeUndefined();
  });

  it('both affirmatively clean stays clean ([])', () => {
    expect(strictestPiiUnion([], [])).toEqual([]);
  });

  it('classified classes union across both sides, deduped', () => {
    expect(strictestPiiUnion(['face'], [])).toEqual(['face']);
    expect(strictestPiiUnion([], ['voice'])).toEqual(['voice']);
    expect(strictestPiiUnion(['face', 'voice'], ['voice', 'id_document'])).toEqual([
      'face',
      'voice',
      'id_document',
    ]);
  });
});
