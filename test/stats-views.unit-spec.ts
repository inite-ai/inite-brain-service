/**
 * STATS_VIEWS_ENABLED gating + fallback unit tests (migration 0088).
 *
 * StatsService.overview and AdminService.collectTenant each have two
 * read paths: flag off → the legacy live GROUP aggregates (with the
 * 30s LRU in StatsService); flag on → the 0088 count() rollup views,
 * no LRU (the view IS the cache), and an error on the view read falls
 * back to the live path with a once-per-tenant warning.
 */
import { StatsService } from '../src/stats/stats.service';
import { AdminService } from '../src/admin/admin.service';

/** Per-statement results for the LEGACY six-count stats query. */
function legacyStatsResults(): unknown[] {
  return [
    [{ c: 7 }], // entities
    [{ c: 5 }], // active
    [{ c: 2 }], // competing
    [{ c: 1 }], // retracted
    [{ c: 3 }], // communities
    [{ c: 4 }], // last 7d
  ];
}

/** Per-statement results for the VIEW-backed stats query. */
function viewStatsResults(): unknown[] {
  return [
    [{ n: 7 }], // stats_entity_total
    [
      { n: 5, status: 'active' },
      { n: 1, status: 'retracted' },
      { n: 9, status: 'superseded' }, // not surfaced — must be ignored
    ], // stats_fact_by_status (no 'competing' group → 0)
    [], // stats_community_total — empty source, no row yet
    [{ c: 4 }], // last 7d (live in both paths)
  ];
}

function makeStatsService(query: jest.Mock) {
  const db = { query };
  const surreal = {
    withScopedCompany: jest.fn((_c: string, _s: readonly string[], fn: (d: unknown) => unknown) =>
      fn(db),
    ),
  };
  const svc = new StatsService(surreal as never);
  const warn = jest.fn();
  (svc as unknown as { logger: { warn: jest.Mock } }).logger = { warn };
  return { svc, warn };
}

describe('StatsService view gating (STATS_VIEWS_ENABLED)', () => {
  const savedFlag = process.env.STATS_VIEWS_ENABLED;

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.STATS_VIEWS_ENABLED;
    else process.env.STATS_VIEWS_ENABLED = savedFlag;
  });

  it('flag off: runs the legacy GROUP queries and serves the 30s LRU', async () => {
    delete process.env.STATS_VIEWS_ENABLED;
    const query = jest.fn(async (_sql: string) => legacyStatsResults());
    const { svc } = makeStatsService(query);

    const first = await svc.overview('t1', []);
    expect(first).toMatchObject({
      entities: 7,
      factsActive: 5,
      factsCompeting: 2,
      factsRetracted: 1,
      communities: 3,
      factsLast7d: 4,
    });
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("WHERE status = 'active'");
    expect(sql).not.toContain('stats_fact_by_status');

    // Second call inside the TTL is served from the LRU — no new query.
    const second = await svc.overview('t1', []);
    expect(second).toBe(first);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('flag on: reads the 0088 views, bypasses the LRU, maps missing groups to 0', async () => {
    process.env.STATS_VIEWS_ENABLED = '1';
    const query = jest.fn(async (_sql: string) => viewStatsResults());
    const { svc } = makeStatsService(query);

    const stats = await svc.overview('t1', []);
    expect(stats).toMatchObject({
      entities: 7,
      factsActive: 5,
      factsCompeting: 0, // group absent in the view → 0
      factsRetracted: 1,
      communities: 0, // GROUP ALL view with no row yet → 0
      factsLast7d: 4,
    });
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain('stats_entity_total');
    expect(sql).toContain('stats_fact_by_status');
    expect(sql).toContain('stats_community_total');
    // The moving window stays a live count even on the view path.
    expect(sql).toContain('recordedAt > type::datetime($weekAgoIso)');

    // No LRU on the view path — the second call queries again.
    await svc.overview('t1', []);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('flag on + view read error: falls back to live counts and warns once per tenant', async () => {
    process.env.STATS_VIEWS_ENABLED = '1';
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('stats_entity_total')) {
        throw new Error('no such table');
      }
      return legacyStatsResults();
    });
    const { svc, warn } = makeStatsService(query);

    const stats = await svc.overview('t1', []);
    expect(stats.entities).toBe(7);
    expect(stats.factsCompeting).toBe(2); // legacy result, not the view one
    expect(warn).toHaveBeenCalledTimes(1);

    // Fallback caches like the legacy path; failing again logs nothing new.
    await svc.overview('t1', []);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('StatsService per-user scope (audit F3)', () => {
  const savedFlag = process.env.STATS_VIEWS_ENABLED;

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.STATS_VIEWS_ENABLED;
    else process.env.STATS_VIEWS_ENABLED = savedFlag;
  });

  /** Per-statement results for the USER-scoped live query (5 statements,
   *  no community_node). */
  function userScopedResults(): unknown[] {
    return [
      [{ c: 4 }], // entities (own + tenant-global)
      [{ c: 3 }], // active
      [{ c: 1 }], // competing
      [{ c: 0 }], // retracted
      [{ c: 2 }], // last 7d
    ];
  }

  it('scopes every count to own+global, omits the tenant-global community count, keys cache by user', async () => {
    delete process.env.STATS_VIEWS_ENABLED;
    const query = jest.fn(async (_sql: string, _binds?: Record<string, unknown>) =>
      userScopedResults(),
    );
    const { svc } = makeStatsService(query);

    const stats = await svc.overview('t1', ['brain:read'], 'user_a');
    expect(stats).toMatchObject({
      entities: 4,
      factsActive: 3,
      factsCompeting: 1,
      factsRetracted: 0,
      factsLast7d: 2,
    });
    // community_node carries no userId → the count is OMITTED (not 0, not
    // the tenant figure) for an end-user caller.
    expect(stats.communities).toBeUndefined();
    expect('communities' in stats).toBe(false);

    const call = query.mock.calls[0]!;
    const sql = call[0] as string;
    const binds = call[1] as Record<string, unknown>;
    expect(sql).toContain('(userId IS NONE OR userId = $userId)');
    expect(sql).not.toContain('community_node');
    expect(binds).toMatchObject({ userId: 'user_a' });

    // Cached under the per-user key: a second identical call hits the LRU.
    await svc.overview('t1', ['brain:read'], 'user_a');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('cache key is per-user: user B is never served user A cached counts', async () => {
    delete process.env.STATS_VIEWS_ENABLED;
    const perUser: Record<string, unknown[]> = {
      user_a: [[{ c: 4 }], [{ c: 3 }], [{ c: 1 }], [{ c: 0 }], [{ c: 2 }]],
      user_b: [[{ c: 9 }], [{ c: 8 }], [{ c: 0 }], [{ c: 1 }], [{ c: 5 }]],
    };
    let current = 'user_a';
    const query = jest.fn(async (_sql: string) => perUser[current]!);
    const { svc } = makeStatsService(query);

    const a = await svc.overview('t1', ['brain:read'], 'user_a');
    current = 'user_b';
    const b = await svc.overview('t1', ['brain:read'], 'user_b');

    expect(a.factsActive).toBe(3);
    expect(b.factsActive).toBe(8); // B's own numbers, NOT A's cached 3
    // Distinct cache keys → two DB round-trips; a tenant-only key would
    // have served A's cached entry to B on the second call.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('takes the live user-scoped path even when STATS_VIEWS_ENABLED=on (views are tenant-wide)', async () => {
    process.env.STATS_VIEWS_ENABLED = '1';
    const query = jest.fn(async (_sql: string) => userScopedResults());
    const { svc } = makeStatsService(query);

    const stats = await svc.overview('t1', ['brain:read'], 'user_a');
    expect(stats.factsActive).toBe(3);
    const sql = query.mock.calls[0]![0];
    // A userId-pinned caller must NOT read the tenant-wide rollup views.
    expect(sql).not.toContain('stats_entity_total');
    expect(sql).not.toContain('stats_fact_by_status');
    expect(sql).toContain('(userId IS NONE OR userId = $userId)');
  });

  it('M2M and user callers use different cache keys AND different queries', async () => {
    delete process.env.STATS_VIEWS_ENABLED;
    // One mock, two shapes: the user path is recognisable by its gate.
    const query = jest.fn(async (sql: string) =>
      sql.includes('userId = $userId') ? userScopedResults() : legacyStatsResults(),
    );
    const { svc } = makeStatsService(query);

    const m2m = await svc.overview('t1', ['brain:read']); // cache key 't1'
    const user = await svc.overview('t1', ['brain:read'], 'user_a'); // key 't1 user_a'

    // M2M is unchanged: tenant-wide counts, community count still present.
    expect(m2m).toMatchObject({ entities: 7, factsActive: 5, factsCompeting: 2 });
    expect(m2m.communities).toBe(3);
    // User caller got its OWN scoped numbers, NOT the M2M cache entry, and
    // no community count.
    expect(user).toMatchObject({ entities: 4, factsActive: 3 });
    expect(user.communities).toBeUndefined();
    // Two distinct keys → two DB round-trips; a shared tenant-only key
    // would have served the M2M entry to the user (query called once).
    expect(query).toHaveBeenCalledTimes(2);
    const m2mSql = query.mock.calls[0]![0];
    expect(m2mSql).toContain('FROM community_node');
    expect(m2mSql).not.toContain('(userId IS NONE OR userId = $userId)');
  });
});

/** Per-statement results for the LEGACY admin collectTenant query. */
function legacyAdminResults(): unknown[] {
  return [
    [{ c: 7 }], // entities
    [{ c: 5 }], // active
    [{ c: 1 }], // retracted
    [], // dead-letter last 20
    [{ c: 0 }], // dead-letter 24h
    [], // forgotten last 20
    [{ c: 0 }], // forgotten 24h
  ];
}

/** Per-statement results for the VIEW-backed admin collectTenant query. */
function viewAdminResults(): unknown[] {
  return [
    [{ n: 7 }], // stats_entity_total
    [
      { n: 5, status: 'active' },
      { n: 2, status: 'competing' }, // admin row does not surface it
      { n: 1, status: 'retracted' },
    ],
    [], // dead-letter last 20
    [{ c: 0 }], // dead-letter 24h
    [], // forgotten last 20
    [{ c: 0 }], // forgotten 24h
  ];
}

type CollectTenantResult = {
  row: { companyId: string; entities: number; factsActive: number; factsRetracted: number };
};

function makeAdminService(query: jest.Mock) {
  const db = { query };
  const surreal = {
    withCompany: jest.fn((_c: string, fn: (d: unknown) => unknown) => fn(db)),
  };
  const svc = new AdminService(
    { knownCompanyIds: () => ['t1'] } as never,
    surreal as never,
    {} as never,
  );
  const warn = jest.fn();
  (svc as unknown as { logger: { warn: jest.Mock } }).logger = { warn };
  const collect = (companyId: string) =>
    (
      svc as unknown as {
        collectTenant: (c: string, d: string) => Promise<CollectTenantResult>;
      }
    ).collectTenant(companyId, new Date().toISOString());
  return { collect, warn };
}

describe('AdminService.collectTenant view gating (STATS_VIEWS_ENABLED)', () => {
  const savedFlag = process.env.STATS_VIEWS_ENABLED;

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.STATS_VIEWS_ENABLED;
    else process.env.STATS_VIEWS_ENABLED = savedFlag;
  });

  it('flag off: runs the legacy GROUP queries', async () => {
    delete process.env.STATS_VIEWS_ENABLED;
    const query = jest.fn(async (_sql: string) => legacyAdminResults());
    const { collect } = makeAdminService(query);

    const out = await collect('t1');
    expect(out.row).toEqual({
      companyId: 't1',
      entities: 7,
      factsActive: 5,
      factsRetracted: 1,
    });
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("WHERE status = 'active'");
    expect(sql).not.toContain('stats_fact_by_status');
  });

  it('flag on: reads the views; windows and row reads stay live', async () => {
    process.env.STATS_VIEWS_ENABLED = '1';
    const query = jest.fn(async (_sql: string) => viewAdminResults());
    const { collect } = makeAdminService(query);

    const out = await collect('t1');
    expect(out.row).toEqual({
      companyId: 't1',
      entities: 7,
      factsActive: 5,
      factsRetracted: 1,
    });
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain('stats_entity_total');
    expect(sql).toContain('stats_fact_by_status');
    expect(sql).toContain('rejectedAt > type::datetime($dayAgoIso)');
  });

  it('flag on + view read error: falls back live and warns once per tenant', async () => {
    process.env.STATS_VIEWS_ENABLED = '1';
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('stats_entity_total')) {
        throw new Error('no such table');
      }
      return legacyAdminResults();
    });
    const { collect, warn } = makeAdminService(query);

    const out = await collect('t1');
    expect(out.row.entities).toBe(7);
    expect(warn).toHaveBeenCalledTimes(1);

    await collect('t1');
    expect(warn).toHaveBeenCalledTimes(1); // logged once per tenant
  });
});
