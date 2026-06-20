/**
 * Unit-test for correlationIdMiddleware + the ALS-backed
 * getCorrelationId() reader. Verifies:
 *   - a new id is minted when no upstream header is present
 *   - an upstream `x-request-id` is honoured
 *   - an upstream `x-correlation-id` is honoured (second precedence)
 *   - the chosen id is set on the response header
 *   - the ALS store is populated inside the request handler
 *   - oversize header values are capped (defence vs hostile upstream)
 */
import { correlationIdMiddleware } from '../src/common/correlation-id.middleware';
import { getCorrelationId } from '../src/common/request-context';

describe('correlationIdMiddleware', () => {
  function mk(req: Partial<{ headers: Record<string, unknown> }> = {}) {
    const headers: Record<string, unknown> = {};
    const res: any = {
      headers,
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
    };
    const mw = correlationIdMiddleware();
    return { req, res, mw };
  }

  it('mints a UUID-shaped id when no upstream header is present', () => {
    const { req, res, mw } = mk();
    let observed: string | undefined;
    mw(req as any, res as any, () => {
      observed = getCorrelationId();
    });
    expect(observed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(res.headers['x-request-id']).toBe(observed);
  });

  it('honours an upstream x-request-id header', () => {
    const { req, res, mw } = mk({
      headers: { 'x-request-id': 'cust-req-42' },
    });
    let observed: string | undefined;
    mw(req as any, res as any, () => {
      observed = getCorrelationId();
    });
    expect(observed).toBe('cust-req-42');
    expect(res.headers['x-request-id']).toBe('cust-req-42');
  });

  it('falls back to x-correlation-id when x-request-id is absent', () => {
    const { req, res, mw } = mk({
      headers: { 'x-correlation-id': 'spring-trace-001' },
    });
    let observed: string | undefined;
    mw(req as any, res as any, () => {
      observed = getCorrelationId();
    });
    expect(observed).toBe('spring-trace-001');
  });

  it('caps oversize header values at 128 chars', () => {
    const oversized = 'X'.repeat(500);
    const { req, res, mw } = mk({ headers: { 'x-request-id': oversized } });
    let observed: string | undefined;
    mw(req as any, res as any, () => {
      observed = getCorrelationId();
    });
    expect(observed?.length).toBe(128);
  });

  it('getCorrelationId returns undefined outside a request', () => {
    expect(getCorrelationId()).toBeUndefined();
  });
});
