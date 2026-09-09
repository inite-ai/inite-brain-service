import { HnswMaintenanceService, resolveBuildWaitMs } from '../src/admin/hnsw-maintenance.service';

/**
 * Every HNSW build is CONCURRENTLY (roadmap embedding-spaces-2026-09 §6 E2).
 *
 * The synchronous `DEFINE INDEX … HNSW` was the only build path this
 * service had, and it is broken at exactly the corpus size the index exists
 * for. Measured on surrealdb/surrealdb:v3.2.4, 20 000 × 1024-d: it aborts
 * after ~133 s with a RocksDB transaction conflict (reproduced at 140 s
 * after a settle), while `CONCURRENTLY` reaches `ready` in 4.2 s. It used
 * to sit behind SEARCH_HNSW_CONCURRENT=0 as the default; a default that is
 * a measured failure is not a configuration, so the flag is gone and the
 * concurrent DDL is the one path.
 *
 * The second half is readiness. A concurrent build EXISTS the moment the
 * DDL returns and is NOT usable until it reports `ready` — measured, a
 * `<|K,EF|>` query against an index at `{"status":"indexing"}` returns the
 * same unranked, null-distance table-order rows it returns with no index at
 * all. So the route must report the build state rather than let the
 * operator assume it before flipping SEARCH_HNSW_ENABLED — and how long ONE
 * request holds for that state is the request's own `waitMs`, not an
 * environment knob.
 */

const INFO_TABLE = (indexes: string[]) => [
  {
    events: {},
    fields: {},
    indexes: Object.fromEntries(indexes.map((n) => [n, `DEFINE INDEX ${n} …`])),
    lives: {},
    tables: {},
  },
];

const ALL_INDEXES = [
  'fact_embedding_hnsw',
  'fact_alt_embedding_hnsw',
  'entity_embedding_hnsw',
  'segment_embedding_hnsw',
];

/**
 * A db that records every statement and answers the two INFO probes from
 * `state`, so a test can put the tenant in "indexing" or "ready" without a
 * container.
 */
function fakeDb(state: 'ready' | 'indexing' | 'absent') {
  const calls: string[] = [];
  const query = jest.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.startsWith('INFO FOR TABLE')) {
      return INFO_TABLE(state === 'absent' ? [] : ALL_INDEXES);
    }
    if (sql.startsWith('INFO FOR INDEX')) {
      return [{ building: { initial: 20000, pending: 0, status: state } }];
    }
    return [null];
  });
  return { calls, query };
}

function service(db: ReturnType<typeof fakeDb>, dimension = 1024) {
  const surreal = {
    withCompany: async <T>(_c: string, fn: (d: unknown) => Promise<T>): Promise<T> => fn(db),
  };
  const embedder = {
    primaryDimensions: () => dimension,
    primarySpaceId: () => `bge:bge-m3:${dimension}:l2`,
  };
  return new HnswMaintenanceService(surreal as never, embedder as never);
}

/** Statements that emit DDL, i.e. everything but the readiness probes. */
const ddl = (calls: string[]) => calls.filter((c) => !c.startsWith('INFO FOR'));

describe('hnsw create — always CONCURRENTLY', () => {
  it('removes first, then defines each index CONCURRENTLY on its own statement', async () => {
    const db = fakeDb('ready');
    const res = await service(db).apply('co1', 'create', { waitMs: 0 });
    const statements = ddl(db.calls);
    // 1 REMOVE + 4 DEFINE. Not a super-statement: one failing DEFINE inside
    // a multi-statement query takes its siblings with it, and each
    // concurrent build has its own progress row.
    expect(statements).toHaveLength(5);
    expect(statements[0]).toContain('REMOVE INDEX IF EXISTS');
    expect(statements[0]).not.toContain('DEFINE INDEX');
    for (const s of statements.slice(1)) {
      expect(s).toContain('DEFINE INDEX');
      expect(s).toMatch(/CONCURRENTLY;$/);
      // The width still comes from the PRIMARY embedder, never the fallback.
      expect(s).toContain('HNSW DIMENSION 1024');
    }
    expect(res.concurrent).toBe(true);
    expect(res.dimension).toBe(1024);
    expect(res.ready).toBe(true);
  });

  it('there is no synchronous path left: nothing an operator sets produces the super-statement', async () => {
    process.env.SEARCH_HNSW_CONCURRENT = '0';
    try {
      const db = fakeDb('ready');
      await service(db).apply('co1', 'create', { waitMs: 0 });
      expect(ddl(db.calls)).toHaveLength(5);
      expect(ddl(db.calls).every((s) => s.includes('CONCURRENTLY') || s.startsWith('REMOVE'))).toBe(
        true,
      );
    } finally {
      delete process.env.SEARCH_HNSW_CONCURRENT;
    }
  });

  it('an index that EXISTS but is still indexing is reported not-ready', async () => {
    // The measured trap: this state serves the same unranked null-distance
    // rows as a missing index, so "the DDL applied" must not read as done.
    const db = fakeDb('indexing');
    const res = await service(db).apply('co1', 'create', { waitMs: 0 });
    expect(res.ready).toBe(false);
    expect(res.builds.map((b) => b.state)).toEqual([
      'building',
      'building',
      'building',
      'building',
    ]);
    // Progress is surfaced, not just a boolean.
    expect(res.builds[0]!.initial).toBe(20000);
    expect(res.builds[0]!.pending).toBe(0);
  });
});

describe('waitMs — the request decides how long it holds', () => {
  afterEach(() => {
    delete process.env.SEARCH_HNSW_BUILD_WAIT_MS;
    jest.useRealTimers();
  });

  it('defaults to 60 s, and refuses anything that is not a bounded non-negative integer', () => {
    expect(resolveBuildWaitMs(undefined)).toBe(60_000);
    expect(resolveBuildWaitMs(0)).toBe(0);
    expect(resolveBuildWaitMs(600_000)).toBe(600_000);
    for (const bad of [-1, 1.5, 600_001, Number.NaN]) {
      expect(() => resolveBuildWaitMs(bad)).toThrow(
        /waitMs must be an integer between 0 and 600000/,
      );
    }
  });

  it('a bad waitMs is refused BEFORE any DDL — a malformed wait must not cost a rebuild', async () => {
    const db = fakeDb('ready');
    await expect(service(db).apply('co1', 'create', { waitMs: -5 })).rejects.toMatchObject({
      status: 400,
    });
    expect(db.calls).toEqual([]);
  });

  it('the environment no longer decides the wait', async () => {
    jest.useFakeTimers();
    process.env.SEARCH_HNSW_BUILD_WAIT_MS = '60000';
    const db = fakeDb('indexing');
    const pending = service(db).apply('co1', 'create', { waitMs: 0 });
    await jest.advanceTimersByTimeAsync(0);
    const res = await pending;
    expect(res.ready).toBe(false);
    // One probe round (DDL + first probe), no polling.
    expect(db.calls.filter((c) => c.startsWith('INFO FOR TABLE'))).toHaveLength(4);
  });
});

describe('hnsw status / drop', () => {
  it("action:'status' emits no DDL at all", async () => {
    const db = fakeDb('indexing');
    const res = await service(db).apply('co1', 'status');
    expect(ddl(db.calls)).toEqual([]);
    expect(res.action).toBe('status');
    expect(res.ready).toBe(false);
    expect(res.builds.every((b) => b.state === 'building')).toBe(true);
  });

  it("action:'status' on an un-indexed tenant reports absent, not ready", async () => {
    const db = fakeDb('absent');
    const res = await service(db).apply('co1', 'status');
    expect(res.builds.map((b) => b.state)).toEqual(['absent', 'absent', 'absent', 'absent']);
    expect(res.ready).toBe(false);
    // INFO FOR INDEX throws on a missing index, so it must not be called.
    expect(db.calls.some((c) => c.startsWith('INFO FOR INDEX'))).toBe(false);
  });

  it('drop removes the four indexes and never claims ready', async () => {
    const db = fakeDb('absent');
    const res = await service(db).apply('co1', 'drop');
    const statements = ddl(db.calls);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('REMOVE INDEX IF EXISTS segment_embedding_hnsw');
    expect(statements[0]).not.toContain('DEFINE INDEX');
    expect(res.ready).toBe(false);
  });

  it('a probe failure degrades to unknown rather than failing the route', async () => {
    const db = {
      calls: [] as string[],
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('INFO FOR')) throw new Error('connection reset');
        return [null];
      }),
    };
    const res = await service(db as never).apply('co1', 'status');
    expect(res.builds.map((b) => b.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(res.ready).toBe(false);
  });

  it('still refuses an implausible embedder dimension before touching DDL', async () => {
    const db = fakeDb('ready');
    await expect(service(db, 4).apply('co1', 'create')).rejects.toThrow(/implausible dimension/);
    expect(db.calls).toEqual([]);
  });
});
