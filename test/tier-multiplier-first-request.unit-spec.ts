/**
 * Tier-aware throttling derives the multiplier from the credential the
 * resolver verifies on THIS request — no per-process cache to warm, so a
 * `plan:team` credential gets its widened window on its first request on
 * every replica, and the auth guard reuses the same resolution (memoised
 * on the request) instead of verifying twice.
 */
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { ThrottlerRequest, ThrottlerStorage } from '@nestjs/throttler';
import { TenantThrottlerGuard } from '../src/common/tenant-throttler.guard';
import { CredentialResolverService } from '../src/auth/credential-resolver.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { JwksService } from '../src/auth/jwks.service';
import type { ApiKeyRecord } from '../src/auth/api-key.types';

class TestableGuard extends TenantThrottlerGuard {
  constructor(storage: ThrottlerStorage, credentials?: CredentialResolverService) {
    super({ throttlers: [] }, storage, new Reflector());
    if (credentials) this.credentials = credentials;
  }
  run(props: ThrottlerRequest) {
    return this.handleRequest(props);
  }
}

/** onModuleInit is what fills in the base guard's commonOptions — DI does it in production. */
async function makeGuard(
  storage: ThrottlerStorage,
  credentials?: CredentialResolverService,
): Promise<TestableGuard> {
  const guard = new TestableGuard(storage, credentials);
  await guard.onModuleInit();
  return guard;
}

function makeResolver(record: ApiKeyRecord | null) {
  let resolves = 0;
  const apiKeys = {
    resolve: () => {
      resolves += 1;
      return record;
    },
    noteResolvedTenant: () => undefined,
  } as unknown as ApiKeyService;
  const jwks = {
    enabled: () => false,
    subjectDenied: async () => false,
  } as unknown as JwksService;
  const resolver = new CredentialResolverService(apiKeys, jwks, new ConfigService({}));
  return { resolver, resolves: () => resolves };
}

function makeRequest(token: string) {
  const req: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
  const res = { header: jest.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ThrottlerRequest['context'];
  return { req, res, context };
}

function props(context: ThrottlerRequest['context'], guard: TestableGuard): ThrottlerRequest {
  return {
    context,
    limit: 10,
    ttl: 60_000,
    blockDuration: 60_000,
    throttler: { name: 'default', limit: 10, ttl: 60_000 },
    getTracker: (req) => guard['getTracker'](req as Record<string, unknown>),
    generateKey: (_ctx, tracker, name) => `${name}:${tracker}`,
  };
}

describe('TenantThrottlerGuard — verified tier on the first request', () => {
  const seenLimits: number[] = [];
  const storage: ThrottlerStorage = {
    increment: async (_key, _ttl, limit) => {
      seenLimits.push(limit);
      return { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
    },
  };
  const team: ApiKeyRecord = {
    keyHash: 'sha256:team',
    companyId: 'co_team',
    scopes: ['brain:read'],
    entitlements: ['plan:team'],
  };

  beforeEach(() => {
    seenLimits.length = 0;
    process.env.THROTTLE_TIER_MULTIPLIERS = '{"plan:team":5}';
  });
  afterEach(() => {
    delete process.env.THROTTLE_TIER_MULTIPLIERS;
  });

  it('widens the bucket on the very first request of a plan:team credential', async () => {
    const { resolver } = makeResolver(team);
    const guard = await makeGuard(storage, resolver);
    const { context } = makeRequest('team-key');
    expect(await guard.run(props(context, guard))).toBe(true);
    expect(seenLimits).toEqual([50]);
  });

  it('resolves the credential once per request, shared with the auth guard', async () => {
    const { resolver, resolves } = makeResolver(team);
    const guard = await makeGuard(storage, resolver);
    const { req, context } = makeRequest('team-key');
    // Two named throttlers on one request, then the auth guard's own call.
    await guard.run(props(context, guard));
    await guard.run(props(context, guard));
    const record = await resolver.resolve('team-key', req);
    expect(record?.companyId).toBe('co_team');
    expect(resolves()).toBe(1);
  });

  it('keeps the default limit for a credential without a tiered entitlement', async () => {
    const { resolver } = makeResolver({ ...team, entitlements: ['plan:free'] });
    const guard = await makeGuard(storage, resolver);
    const { context } = makeRequest('free-key');
    await guard.run(props(context, guard));
    expect(seenLimits).toEqual([10]);
  });

  it('keeps the default limit when the credential does not verify', async () => {
    const { resolver } = makeResolver(null);
    const guard = await makeGuard(storage, resolver);
    const { context } = makeRequest('forged-key');
    await guard.run(props(context, guard));
    expect(seenLimits).toEqual([10]);
  });

  it('keeps the default limit, without throwing, when the resolver fails', async () => {
    const resolver = {
      resolve: async () => {
        throw new Error('jwks unreachable');
      },
    } as unknown as CredentialResolverService;
    const guard = await makeGuard(storage, resolver);
    const { context } = makeRequest('any-key');
    expect(await guard.run(props(context, guard))).toBe(true);
    expect(seenLimits).toEqual([10]);
  });

  it('keeps the default limit when no resolver is wired (unit fixtures)', async () => {
    const guard = await makeGuard(storage);
    const { context } = makeRequest('any-key');
    await guard.run(props(context, guard));
    expect(seenLimits).toEqual([10]);
  });
});
