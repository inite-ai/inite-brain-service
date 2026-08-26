/**
 * Pins the payload-digest extraction (src/common/payload-digest.ts) to
 * the exact behavior it had inside src/strategy/trajectory-digest.ts —
 * the strategy digester re-exports it, so these snapshots double as the
 * zero-behavior-change proof for the extraction.
 */
import { createHash } from 'node:crypto';
import { digestPayload, PAYLOAD_DIGEST_LEN, stableStringify } from '../src/common/payload-digest';
import {
  TRAJECTORY_DIGEST_LEN,
  digestPayload as trajectoryDigestPayload,
  toToolStep,
} from '../src/strategy/trajectory-digest';

describe('payload-digest', () => {
  it('is stable across object key order', () => {
    const a = digestPayload({ b: 1, a: { d: 2, c: 3 } });
    const b = digestPayload({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('distinguishes different payloads', () => {
    expect(digestPayload({ q: 'x' })).not.toBe(digestPayload({ q: 'y' }));
  });

  it('is a 16-hex SHA-256 prefix of the sanitized canonical JSON', () => {
    const value = { query: 'hello', limit: 5 };
    const expected = createHash('sha256')
      .update(stableStringify(value))
      .digest('hex')
      .slice(0, PAYLOAD_DIGEST_LEN);
    expect(digestPayload(value)).toBe(expected);
    expect(digestPayload(value)).toHaveLength(16);
  });

  it('treats undefined as null (absent payload digests identically)', () => {
    expect(digestPayload(undefined)).toBe(digestPayload(null));
  });

  it('snapshot: known digests (any drift here is a provenance break)', () => {
    expect({
      empty: digestPayload(undefined),
      emptyObject: digestPayload({}),
      sample: digestPayload({ b: 1, a: 'x' }),
      list: digestPayload([1, 'two', { three: 3 }]),
    }).toMatchSnapshot();
  });

  it('strategy trajectory-digest re-exports THIS function unchanged', () => {
    expect(trajectoryDigestPayload).toBe(digestPayload);
    expect(TRAJECTORY_DIGEST_LEN).toBe(PAYLOAD_DIGEST_LEN);
    // toToolStep still produces the same digests it always did.
    const step = toToolStep({ tool: 'search', args: { q: 'x' }, result: { hits: 2 }, ok: true });
    expect(step.argsDigest).toBe(digestPayload({ q: 'x' }));
    expect(step.resultDigest).toBe(digestPayload({ hits: 2 }));
  });
});
