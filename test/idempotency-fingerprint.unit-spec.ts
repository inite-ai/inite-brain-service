import { canonical, fingerprintOf } from '../src/idempotency/idempotency.interceptor';

describe('Idempotency-Key request fingerprint', () => {
  const req = (body: unknown, query: Record<string, unknown> = {}) => ({
    method: 'POST',
    params: {},
    query,
    body,
  });

  it('ignores key order, at every depth', () => {
    expect(canonical({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      canonical({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 }),
    );
  });

  it('a different body, query or route is a different request', () => {
    const base = fingerprintOf(req({ object: 'gold' }) as never, '/v1/ingest/fact');
    expect(fingerprintOf(req({ object: 'gold' }) as never, '/v1/ingest/fact')).toBe(base);
    expect(fingerprintOf(req({ object: 'platinum' }) as never, '/v1/ingest/fact')).not.toBe(base);
    expect(
      fingerprintOf(req({ object: 'gold' }, { dry: '1' }) as never, '/v1/ingest/fact'),
    ).not.toBe(base);
    expect(fingerprintOf(req({ object: 'gold' }) as never, '/v1/ingest/mention')).not.toBe(base);
  });

  it('an absent key and an undefined one are the same request', () => {
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
  });
});
