/**
 * A flood of random bearer tokens is a flood from one source, not N
 * callers. Keyed by the token's own hash, every junk token got a fresh
 * bucket and nothing was ever throttled; and each unknown `ik_` token
 * cost a remote introspection call against the auth-service's quota, so
 * the flood could starve real keys of verification. Now an unverified
 * token is bucketed by IP, failed verifications spend a per-IP budget,
 * and once that budget is blocked the next junk token is refused BEFORE
 * it is verified (OWASP ASVS V2.2.1).
 */
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerException, type ThrottlerRequest } from '@nestjs/throttler';
import { TenantThrottlerGuard } from '../src/common/tenant-throttler.guard';
import { SurrealThrottlerStorage } from '../src/common/surreal-throttler.storage';
import { CredentialResolverService } from '../src/auth/credential-resolver.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { JwksService } from '../src/auth/jwks.service';
import type { ApiKeyRecord } from '../src/auth/api-key.types';

class TestableGuard extends TenantThrottlerGuard {
  constructor(storage: SurrealThrottlerStorage, credentials: CredentialResolverService) {
    super({ throttlers: [] }, storage, new Reflector());
    this.credentials = credentials;
  }
  run(props: ThrottlerRequest) {
    return this.handleRequest(props);
  }
  tracker(req: Record<string, unknown>) {
    return this.getTracker(req);
  }
}

const GOOD = 'brain_good';
const RECORD = {
  companyId: 'co_a',
  scopes: ['brain:read'],
  keyHash: 'h',
} as unknown as ApiKeyRecord;

function resolver() {
  let verified = 0;
  const apiKeys = {
    resolve: (token: string) => {
      verified += 1;
      return token === GOOD ? RECORD : null;
    },
    resolveStored: async () => null,
    noteResolvedTenant: () => undefined,
  } as unknown as ApiKeyService;
  const jwks = { enabled: () => false, subjectDenied: async () => false } as unknown as JwksService;
  const r = new CredentialResolverService(apiKeys, jwks, new ConfigService({}));
  return { r, verified: () => verified };
}

function request(token: string, ip = '203.0.113.7') {
  const req: Record<string, unknown> = { ip, headers: { authorization: `Bearer ${token}` } };
  const res = { header: jest.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ThrottlerRequest['context'];
  return { req, context };
}

function props(context: ThrottlerRequest['context'], guard: TestableGuard): ThrottlerRequest {
  return {
    context,
    limit: 3,
    ttl: 60_000,
    blockDuration: 60_000,
    throttler: { name: 'default', limit: 3, ttl: 60_000 },
    getTracker: (req) => guard.tracker(req as Record<string, unknown>),
    generateKey: (_ctx, tracker, name) => `${name}:${tracker}`,
  };
}

describe('TenantThrottlerGuard — failed authentication', () => {
  it('a junk token is bucketed by IP, a verified one by its credential', async () => {
    const { r } = resolver();
    const guard = new TestableGuard(new SurrealThrottlerStorage(), r);
    await guard.onModuleInit();
    expect(await guard.tracker(request('junk-1').req)).toBe('ip:203.0.113.7');
    expect(await guard.tracker(request(GOOD).req)).toMatch(/^k:/);
  });

  it('once the per-IP failure budget is spent, the next junk token is refused before it is verified', async () => {
    const { r, verified } = resolver();
    const guard = new TestableGuard(new SurrealThrottlerStorage(), r);
    await guard.onModuleInit();
    let refused = 0;
    for (let i = 0; i < 10; i += 1) {
      const { context } = request(`junk-${i}`);
      try {
        await guard.run(props(context, guard));
      } catch (e) {
        expect(e).toBeInstanceOf(ThrottlerException);
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(0);
    // Verification stopped once the budget blocked: limit + 1 failures
    // block the bucket, after which junk costs no verification.
    expect(verified()).toBeLessThanOrEqual(4);
    // A real key from another source is untouched.
    const { context } = request(GOOD, '198.51.100.9');
    await expect(guard.run(props(context, guard))).resolves.toBe(true);
  });
});
