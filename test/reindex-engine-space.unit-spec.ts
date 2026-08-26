/**
 * Multilingual Tier 2 — ReindexEngineService.
 *
 * Proves:
 *   - DEFAULT (allTables off, tracking off): only knowledge_fact is
 *     SELECTed, the UPDATE is the pre-Tier-2 `SET embedding = $embedding`
 *     (no embeddingSpaceId), and the result carries NO `tables` key. Byte-
 *     identical to the historical reindex.
 *   - allTables ON: the non-fact tables are swept and a per-table breakdown
 *     is returned.
 *   - EMBEDDING_SPACE_TRACKING ON: every rewrite ALSO stamps
 *     `embeddingSpaceId = <active space>`.
 */
import { ReindexEngineService } from '../src/ai/embedder/reindex-engine.service';

interface QueryCall {
  sql: string;
  params: Record<string, unknown> | undefined;
}

/** Fake Surreal DB — answers the paginated SELECTs from a per-table page and
 *  records the UPDATE statements so the test can inspect the SET clause. */
function makeDb(pages: Record<string, Array<Record<string, unknown>>>) {
  const calls: QueryCall[] = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      calls.push({ sql, params });
      if (/^\s*UPDATE/.test(sql)) return [[]];
      // SELECT — first page returns rows, subsequent pages empty.
      const offset = Number(params?.offset ?? 0);
      for (const [table, rows] of Object.entries(pages)) {
        if (sql.includes(`FROM ${table}`)) return [offset === 0 ? rows : []];
      }
      return [[]];
    },
  };
  return { db, calls };
}

const ACTIVE_SPACE = 'openai:text-embedding-3-small:1536:l2';

function makeEngine(opts: {
  pages: Record<string, Array<Record<string, unknown>>>;
  tracking?: string;
}) {
  const { db, calls } = makeDb(opts.pages);
  const surreal = {
    withCompany: async <T>(_c: string, fn: (d: typeof db) => Promise<T>) => fn(db),
  } as never;
  const embedder = {
    embedMany: async (texts: string[]) => texts.map(() => [1, 2, 3]),
    activeSpaceId: () => ACTIVE_SPACE,
    cacheStats: () => ({ provider: 'openai:text-embedding-3-small:1536' }),
  } as never;
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'REINDEX_BATCH_SIZE') return '200';
      if (k === 'EMBEDDING_SPACE_TRACKING') return opts.tracking;
      return def;
    },
  } as never;
  return { engine: new ReindexEngineService(surreal, embedder, config), calls };
}

const FACT_PAGE = [{ id: 'knowledge_fact:1', predicate: 'status', object: 'active' }];
const ALL_PAGES = {
  knowledge_fact: FACT_PAGE,
  knowledge_entity: [{ id: 'knowledge_entity:1', name: 'Alice', canonicalName: 'Alice' }],
  knowledge_predicate: [
    { id: 'knowledge_predicate:1', predicateId: 'works_at', description: 'employer' },
  ],
  episode: [{ id: 'episode:1', text: 'hello world' }],
  episode_segment: [{ id: 'episode_segment:1', text: 'segment text' }],
  memory_episode: [{ id: 'memory_episode:1', gist: 'scene gist' }],
  strategy_memory: [{ id: 'strategy_memory:1', title: 'T', situation: 'S' }],
};

describe('ReindexEngineService — default path (byte-identical)', () => {
  it('reindexes knowledge_fact ONLY and returns no tables key', async () => {
    const { engine, calls } = makeEngine({ pages: ALL_PAGES });
    const res = await engine.reindexTenant('acme', { dryRun: false, remaining: 1000 });

    expect(res.factsScanned).toBe(1);
    expect(res.factsUpdated).toBe(1);
    expect(res).not.toHaveProperty('tables');

    // No non-fact table was ever SELECTed.
    const selects = calls.filter((c) => /^\s*SELECT/.test(c.sql));
    expect(selects.every((c) => c.sql.includes('FROM knowledge_fact'))).toBe(true);

    // The UPDATE is exactly the historical clause — NO embeddingSpaceId.
    const updates = calls.filter((c) => /^\s*UPDATE/.test(c.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toContain('SET embedding = $embedding');
    expect(updates[0]!.sql).not.toContain('embeddingSpaceId');
  });

  it('dryRun writes nothing', async () => {
    const { engine, calls } = makeEngine({ pages: ALL_PAGES });
    const res = await engine.reindexTenant('acme', { dryRun: true, remaining: 1000 });
    expect(res.factsScanned).toBe(1);
    expect(res.factsUpdated).toBe(0);
    expect(calls.some((c) => /^\s*UPDATE/.test(c.sql))).toBe(false);
  });
});

describe('ReindexEngineService — opt-in all-tables sweep', () => {
  it('sweeps the non-fact tables and returns a per-table breakdown', async () => {
    const { engine } = makeEngine({ pages: ALL_PAGES });
    const res = await engine.reindexTenant('acme', {
      dryRun: false,
      remaining: 1000,
      allTables: true,
    });
    expect(res.factsUpdated).toBe(1);
    expect(res.tables).toBeDefined();
    const tables = (res.tables ?? []).map((t) => t.table);
    expect(tables).toEqual([
      'knowledge_entity',
      'knowledge_predicate',
      'episode',
      'episode_segment',
      'memory_episode',
      'strategy_memory',
    ]);
    for (const t of res.tables ?? []) {
      expect(t.scanned).toBe(1);
      expect(t.updated).toBe(1);
    }
  });
});

describe('ReindexEngineService — EMBEDDING_SPACE_TRACKING stamping', () => {
  it('stamps embeddingSpaceId on the knowledge_fact rewrite when tracking is on', async () => {
    const { engine, calls } = makeEngine({ pages: ALL_PAGES, tracking: '1' });
    await engine.reindexTenant('acme', { dryRun: false, remaining: 1000 });
    const update = calls.find((c) => /^\s*UPDATE/.test(c.sql))!;
    expect(update.sql).toContain('embeddingSpaceId = $space');
    expect(update.params?.space).toBe(ACTIVE_SPACE);
  });

  it('stamps embeddingSpaceId across ALL swept tables', async () => {
    const { engine, calls } = makeEngine({ pages: ALL_PAGES, tracking: '1' });
    await engine.reindexTenant('acme', { dryRun: false, remaining: 1000, allTables: true });
    const updates = calls.filter((c) => /^\s*UPDATE/.test(c.sql));
    expect(updates).toHaveLength(7); // fact + 6 tables
    for (const u of updates) {
      expect(u.sql).toContain('embeddingSpaceId = $space');
      expect(u.params?.space).toBe(ACTIVE_SPACE);
    }
  });
});
