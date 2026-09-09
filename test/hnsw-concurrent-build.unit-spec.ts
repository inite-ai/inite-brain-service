import { HnswMaintenanceService } from '../src/admin/hnsw-maintenance.service';

/**
 * SEARCH_HNSW_CONCURRENT (roadmap embedding-spaces-2026-09 §6 E2).
 *
 * The only index-build path this service had is broken at exactly the
 * corpus size the index exists for. Measured on surrealdb/surrealdb:v3.2.4,
 * 20 000 × 1024-d: a synchronous `DEFINE INDEX … HNSW` aborts after ~133 s
 * with a RocksDB transaction conflict (reproduced at 140 s after a settle),
 * while `CONCURRENTLY` reaches `ready` in 4.2 s.
 *
 * The second half is readiness. A concurrent build EXISTS the moment the
 * DDL returns and is NOT usable until it reports `ready` — measured, a
 * `<|K,EF|>` query against an index at `{"status":"indexing"}` returns the
 * same unranked, null-distance table-order rows it returns with no index at
 * all. So the route must report the build state rather than let the
 * operator assume it before flipping SEARCH_HNSW_ENABLED.
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

describe('hnsw create — SEARCH_HNSW_CONCURRENT off (byte-identical DDL)', () => {
  beforeEach(() => {
    delete process.env.SEARCH_HNSW_CONCURRENT;
    process.env.SEARCH_HNSW_BUILD_WAIT_MS = '0';
  });
  afterEach(() => {
    delete process.env.SEARCH_HNSW_BUILD_WAIT_MS;
  });

  it('emits the historical single four-index super-statement, with no CONCURRENTLY', async () => {
    const db = fakeDb('ready');
    const res = await service(db).apply('co1', 'create');
    const statements = ddl(db.calls);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('REMOVE INDEX IF EXISTS fact_embedding_hnsw');
    expect(statements[0]).toContain('DEFINE INDEX segment_embedding_hnsw');
    expect(statements[0]).not.toContain('CONCURRENTLY');
    expect(res.concurrent).toBe(false);
    // The width still comes from the PRIMARY embedder, never the fallback.
    expect(res.dimension).toBe(1024);
    expect(statements[0]).toContain('HNSW DIMENSION 1024');
  });

  it('reports readiness on the synchronous path too — the state is never assumed', async () => {
    const db = fakeDb('ready');
    const res = await service(db).apply('co1', 'create');
    expect(res.ready).toBe(true);
    expect(res.builds.map((b) => b.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
  });
});

describe('hnsw create — SEARCH_HNSW_CONCURRENT on', () => {
  beforeEach(() => {
    process.env.SEARCH_HNSW_CONCURRENT = '1';
    process.env.SEARCH_HNSW_BUILD_WAIT_MS = '0';
  });
  afterEach(() => {
    delete process.env.SEARCH_HNSW_CONCURRENT;
    delete process.env.SEARCH_HNSW_BUILD_WAIT_MS;
  });

  it('removes first, then defines each index CONCURRENTLY on its own statement', async () => {
    const db = fakeDb('ready');
    const res = await service(db).apply('co1', 'create');
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
      expect(s).toContain('HNSW DIMENSION 1024');
    }
    expect(res.concurrent).toBe(true);
    expect(res.ready).toBe(true);
  });

  it('an index that EXISTS but is still indexing is reported not-ready', async () => {
    // The measured trap: this state serves the same unranked null-distance
    // rows as a missing index, so "the DDL applied" must not read as done.
    const db = fakeDb('indexing');
    const res = await service(db).apply('co1', 'create');
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

describe('hnsw status / drop', () => {
  afterEach(() => {
    delete process.env.SEARCH_HNSW_CONCURRENT;
    delete process.env.SEARCH_HNSW_BUILD_WAIT_MS;
  });

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
