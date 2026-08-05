import { createHmac } from 'node:crypto';
import { EpisodeSubscriptionService } from '../src/episodes/episode-subscription.service';
import type { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { SurrealService } from '../src/db/surreal.service';

function makeService(opts: {
  subs?: Array<Record<string, unknown>>;
  meta?: Array<Record<string, unknown>>;
}): {
  svc: EpisodeSubscriptionService;
  queries: Array<{ sql: string; params?: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const surreal = {
    withCompany: async (_co: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params?: Record<string, unknown>) => {
          queries.push({ sql, params });
          if (sql.includes('FROM episode_subscription')) {
            return [opts.subs ?? []];
          }
          if (sql.includes('CREATE episode_subscription')) {
            return [[{ id: 'episode_subscription:new1' }]];
          }
          return [[]];
        },
      }),
  } as unknown as SurrealService;
  const episodes = {
    metaSince: async () => opts.meta ?? [],
  } as unknown as EpisodeReadStoreService;
  const apiKeys = {
    knownCompanyIds: () => ['co_x'],
  } as unknown as ApiKeyService;
  return {
    svc: new EpisodeSubscriptionService(surreal, episodes, apiKeys),
    queries,
  };
}

describe('EpisodeSubscriptionService (driver surface 4)', () => {
  const savedFlag = process.env.EPISODE_SUBSCRIPTIONS_ENABLED;
  const realFetch = global.fetch;
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.EPISODE_SUBSCRIPTIONS_ENABLED;
    else process.env.EPISODE_SUBSCRIPTIONS_ENABLED = savedFlag;
    global.fetch = realFetch;
  });

  it('create returns the secret exactly once and stamps a now-watermark', async () => {
    const { svc, queries } = makeService({});
    const out = await svc.create('co_x', 'https://example.com/hook');
    expect(out.id).toBe('episode_subscription:new1');
    expect(out.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(out.watermark)).not.toBeNaN();
    expect(queries[0].sql).toContain('CREATE episode_subscription');
  });

  it('list never selects the secret column', async () => {
    const { svc, queries } = makeService({ subs: [] });
    await svc.list('co_x');
    expect(queries[0].sql).not.toContain('secret');
  });

  it('dispatchTick is inert when the flag is off', async () => {
    delete process.env.EPISODE_SUBSCRIPTIONS_ENABLED;
    const { svc, queries } = makeService({});
    await svc.dispatchTick();
    expect(queries).toHaveLength(0);
  });

  it('delivers a signed metadata batch and CAS-advances the watermark on 2xx', async () => {
    process.env.EPISODE_SUBSCRIPTIONS_ENABLED = '1';
    const sub = {
      id: 'episode_subscription:s1',
      url: 'https://example.com/hook',
      secret: 'shh',
      watermark: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
    };
    const meta = [
      {
        id: 'episode:e1',
        conversationId: 'conv1',
        messageId: 'm1',
        speaker: 'Assistant',
        occurredAt: '2026-08-02T10:00:00.000Z',
        recordedAt: '2026-08-02T10:00:05.000Z',
      },
    ];
    const calls: Array<{ url: string; body: string; sig: string }> = [];
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body),
        sig: String(
          (init?.headers as Record<string, string>)['X-Brain-Signature'],
        ),
      });
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    const { svc, queries } = makeService({ subs: [sub], meta });
    await svc.dispatchTick();

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].body);
    expect(payload.event).toBe('episodes_available');
    expect(payload.episodes[0]).toEqual({
      id: 'episode:e1',
      conversationId: 'conv1',
      messageId: 'm1',
      speaker: 'Assistant',
      occurredAt: '2026-08-02T10:00:00.000Z',
      recordedAt: '2026-08-02T10:00:05.000Z',
    });
    // metadata only — never text
    expect(calls[0].body).not.toContain('"text"');
    const expected = createHmac('sha256', 'shh')
      .update(calls[0].body)
      .digest('hex');
    expect(calls[0].sig).toBe(`sha256=${expected}`);
    const advance = queries.find((q) => q.sql.includes('SET watermark'));
    expect(advance).toBeDefined();
    expect(advance?.sql).toContain('WHERE watermark = <datetime> $old');
    expect(advance?.params).toMatchObject({
      new: '2026-08-02T10:00:05.000Z',
      old: '2026-08-01T00:00:00.000Z',
    });
  });

  it('failure increments failureCount and latches the breaker', async () => {
    process.env.EPISODE_SUBSCRIPTIONS_ENABLED = '1';
    const sub = {
      id: 'episode_subscription:s1',
      url: 'https://dead.example.com/hook',
      secret: 'shh',
      watermark: '2026-08-01T00:00:00.000Z',
      failureCount: 3,
    };
    const meta = [
      {
        id: 'episode:e1',
        messageId: 'm1',
        occurredAt: '2026-08-02T10:00:00.000Z',
        recordedAt: '2026-08-02T10:00:05.000Z',
      },
    ];
    let fetches = 0;
    global.fetch = (async () => {
      fetches += 1;
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const { svc, queries } = makeService({ subs: [sub], meta });
    await svc.dispatchTick();
    const fail = queries.find((q) => q.sql.includes('failureCount = $n'));
    expect(fail?.params).toMatchObject({ n: 4 });
    expect(queries.some((q) => q.sql.includes('SET watermark'))).toBe(false);

    // Breaker: the second tick skips the dead URL without fetching.
    await svc.dispatchTick();
    expect(fetches).toBe(1);
  });
});
