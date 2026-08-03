import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import { SegmentLaneService } from '../src/synthesize/segment-lane.service';
import { EpisodeSubscriptionService } from '../src/episodes/episode-subscription.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { LeaderLeaseService } from '../src/jobs/leader-lease.service';

/**
 * Audit W1 (engine-architecture-audit-2026-08.md #14): migration 0055's
 * user scope was bypassed by every L0 surface — the raw substrate served
 * one user's personal verbatim to any brain:read key. These pin the
 * fail-closed contract the fact read path has always had.
 */
function recorder(): {
  surreal: SurrealService;
  queries: Array<{ sql: string; params?: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const surreal = {
    withCompany: async (_co: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params?: Record<string, unknown>) => {
          queries.push({ sql, params });
          return [[]];
        },
      }),
  } as unknown as SurrealService;
  return { surreal, queries };
}

const GLOBAL_ONLY = 'AND userId IS NONE';
const SCOPED = 'AND (userId IS NONE OR userId = $scopeUserId)';

describe('L0 user-scope fence (0055) — episode read store', () => {
  it('searchText: unscoped read is tenant-global ONLY', async () => {
    const { surreal, queries } = recorder();
    await new EpisodeReadStoreService(surreal).searchText({
      companyId: 'co_x',
      query: 'q',
      limit: 5,
      includePii: true,
    });
    expect(queries[0].sql).toContain(GLOBAL_ONLY);
    expect(queries[0].params?.scopeUserId).toBeUndefined();
  });

  it('searchText: scoped read sees global + own, never another user', async () => {
    const { surreal, queries } = recorder();
    await new EpisodeReadStoreService(surreal).searchText({
      companyId: 'co_x',
      query: 'q',
      limit: 5,
      includePii: true,
      userId: 'u1',
    });
    expect(queries[0].sql).toContain(SCOPED);
    expect(queries[0].params?.scopeUserId).toBe('u1');
  });

  it('byIds: fenced in both modes', async () => {
    const { surreal, queries } = recorder();
    const svc = new EpisodeReadStoreService(surreal);
    await svc.byIds({
      companyId: 'co_x',
      ids: ['episode:e1'],
      includePii: false,
    });
    expect(queries[0].sql).toContain(GLOBAL_ONLY);
    await svc.byIds({
      companyId: 'co_x',
      ids: ['episode:e1'],
      includePii: false,
      userId: 'u1',
    });
    expect(queries[1].sql).toContain(SCOPED);
    expect(queries[1].params?.scopeUserId).toBe('u1');
  });

  it('page (public API): fenced in both modes', async () => {
    const { surreal, queries } = recorder();
    const svc = new EpisodeReadStoreService(surreal);
    await svc.page({ companyId: 'co_x', includePii: false, limit: 10 });
    expect(queries[0].sql).toContain('userId IS NONE');
    await svc.page({
      companyId: 'co_x',
      includePii: false,
      limit: 10,
      userId: 'u1',
    });
    expect(queries[1].sql).toContain('userId = $scopeUserId');
    expect(queries[1].params?.scopeUserId).toBe('u1');
  });

  it('metaSince stays UNGATED by design (metadata only, no text)', async () => {
    const { surreal, queries } = recorder();
    await new EpisodeReadStoreService(surreal).metaSince({
      companyId: 'co_x',
      sinceIso: '2026-08-01T00:00:00.000Z',
      limit: 10,
    });
    expect(queries[0].sql).not.toContain('userId');
    expect(queries[0].sql).not.toContain('text');
  });
});

describe('L0 user-scope fence (0055) — segment lane', () => {
  const savedFlag = process.env.SEARCH_SEGMENT_LANE_ENABLED;
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.SEARCH_SEGMENT_LANE_ENABLED;
    else process.env.SEARCH_SEGMENT_LANE_ENABLED = savedFlag;
  });

  function makeLane(): {
    svc: SegmentLaneService;
    queries: Array<{ sql: string; params?: Record<string, unknown> }>;
  } {
    const { surreal, queries } = recorder();
    const embedder = {
      embed: async () => [0.1, 0.2],
    } as unknown as EmbedderService;
    return { svc: new SegmentLaneService(surreal, embedder), queries };
  }

  it('both legs carry the fence; unscoped is global-only', async () => {
    process.env.SEARCH_SEGMENT_LANE_ENABLED = '1';
    const { svc, queries } = makeLane();
    await svc.transcriptLines({
      companyId: 'co_x',
      query: 'q',
      callerScopes: ['brain:read'],
    });
    expect(queries).toHaveLength(2);
    for (const q of queries) expect(q.sql).toContain(GLOBAL_ONLY);
  });

  it('scoped read passes the param to both legs', async () => {
    process.env.SEARCH_SEGMENT_LANE_ENABLED = '1';
    const { svc, queries } = makeLane();
    await svc.transcriptLines({
      companyId: 'co_x',
      query: 'q',
      callerScopes: ['brain:read'],
      userId: 'u1',
    });
    for (const q of queries) {
      expect(q.sql).toContain(SCOPED);
      expect(q.params?.scopeUserId).toBe('u1');
    }
  });
});

describe('episode subscriptions — single-writer + per-subscription breaker', () => {
  const savedFlag = process.env.EPISODE_SUBSCRIPTIONS_ENABLED;
  afterEach(() => {
    if (savedFlag === undefined)
      delete process.env.EPISODE_SUBSCRIPTIONS_ENABLED;
    else process.env.EPISODE_SUBSCRIPTIONS_ENABLED = savedFlag;
  });

  it('a pod that loses the lease does not scan or push', async () => {
    process.env.EPISODE_SUBSCRIPTIONS_ENABLED = '1';
    const { surreal, queries } = recorder();
    const episodes = {
      metaSince: async () => [],
    } as unknown as EpisodeReadStoreService;
    const apiKeys = {
      knownCompanyIds: () => ['co_x'],
    } as unknown as ApiKeyService;
    const lease = {
      tryAcquire: async () => false,
    } as unknown as LeaderLeaseService;
    const svc = new EpisodeSubscriptionService(
      surreal,
      episodes,
      apiKeys,
      lease,
    );
    await svc.dispatchTick();
    expect(queries).toHaveLength(0);
  });

  it('the lease holder proceeds, and the lease name is stable', async () => {
    process.env.EPISODE_SUBSCRIPTIONS_ENABLED = '1';
    const { surreal, queries } = recorder();
    const episodes = {
      metaSince: async () => [],
    } as unknown as EpisodeReadStoreService;
    const apiKeys = {
      knownCompanyIds: () => ['co_x'],
    } as unknown as ApiKeyService;
    const names: string[] = [];
    const lease = {
      tryAcquire: async (name: string) => {
        names.push(name);
        return true;
      },
    } as unknown as LeaderLeaseService;
    const svc = new EpisodeSubscriptionService(
      surreal,
      episodes,
      apiKeys,
      lease,
    );
    await svc.dispatchTick();
    expect(names).toEqual(['episode_subscriptions']);
    expect(queries.length).toBeGreaterThan(0);
  });
});
