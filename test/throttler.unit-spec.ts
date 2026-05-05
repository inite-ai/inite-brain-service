/**
 * Unit-test for TenantThrottlerGuard's getTracker(): authenticated
 * Bearer-keyed bucketing + IP fallback for unauthenticated requests.
 */
import { TenantThrottlerGuard } from '../src/common/tenant-throttler.guard';

class TestableGuard extends TenantThrottlerGuard {
  publicGetTracker(req: Record<string, unknown>) {
    return this.getTracker(req);
  }
}

describe('TenantThrottlerGuard.getTracker', () => {
  // ThrottlerGuard's constructor is invoked via DI in production. For unit
  // tests we only exercise getTracker, which doesn't read any of the
  // injected fields, so dummy args are safe.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guard = new TestableGuard({} as any, {} as any, {} as any);

  it('hashes Bearer token to produce a stable per-key tracker', async () => {
    const t1 = await guard.publicGetTracker({
      headers: { authorization: 'Bearer abc-123' },
    });
    const t2 = await guard.publicGetTracker({
      headers: { authorization: 'Bearer abc-123' },
    });
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^k:[a-f0-9]{32}$/);
  });

  it('produces different trackers for different tokens', async () => {
    const t1 = await guard.publicGetTracker({
      headers: { authorization: 'Bearer key-A' },
    });
    const t2 = await guard.publicGetTracker({
      headers: { authorization: 'Bearer key-B' },
    });
    expect(t1).not.toBe(t2);
  });

  it('falls back to IP-prefixed tracker for unauthenticated requests', async () => {
    const t = await guard.publicGetTracker({
      headers: {},
      ip: '203.0.113.42',
    });
    expect(t).toBe('ip:203.0.113.42');
  });

  it('falls back to ip:unknown when neither auth nor IP is present', async () => {
    const t = await guard.publicGetTracker({ headers: {} });
    expect(t).toBe('ip:unknown');
  });

  it('does not leak the token in the tracker (no plaintext substring)', async () => {
    const token = 'super-secret-key-12345';
    const t = await guard.publicGetTracker({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(t).not.toContain(token);
  });

  it('treats malformed Authorization header as unauthenticated', async () => {
    const t = await guard.publicGetTracker({
      headers: { authorization: 'Basic abc' },
      ip: '1.2.3.4',
    });
    expect(t).toBe('ip:1.2.3.4');
  });
});
