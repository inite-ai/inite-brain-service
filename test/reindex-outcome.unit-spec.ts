/**
 * Reindex terminal status (src/ai/embedder/reindex-engine.service.ts +
 * reindex-embeddings.service.ts): a page the embedder refused, or a row
 * whose write failed, used to be a warning and a smaller `updated` count.
 * Now the table is a failed unit, the tenant's sweep is `degraded` or
 * `failed`, and `tables` (the retry selector) re-sweeps exactly the named
 * tables. The roster fold treats a tenant that threw as a failed unit.
 */
import { ReindexEngineService } from '../src/ai/embedder/reindex-engine.service';
import { ReindexEmbeddingsService } from '../src/ai/embedder/reindex-embeddings.service';
import type { ApiKeyService } from '../src/auth/api-key.service';

interface QueryCall {
  sql: string;
  params: Record<string, unknown> | undefined;
}

function makeDb(opts: {
  pages: Record<string, Array<Record<string, unknown>>>;
  /** Row ids whose UPDATE throws. */
  failingRows?: string[];
}) {
  const calls: QueryCall[] = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      calls.push({ sql, params });
      if (/^\s*UPDATE/.test(sql)) {
        if (opts.failingRows?.includes(String(params?.id))) throw new Error('write refused');
        return [[]];
      }
      const offset = Number(params?.offset ?? 0);
      for (const [table, rows] of Object.entries(opts.pages)) {
        if (sql.includes(`FROM ${table}`)) return [offset === 0 ? rows : []];
      }
      return [[]];
    },
  };
  return { db, calls };
}

function makeEngine(opts: {
  pages: Record<string, Array<Record<string, unknown>>>;
  failingRows?: string[];
  /** Texts whose embed batch throws (matched by inclusion). */
  failingTexts?: string[];
}) {
  const { db, calls } = makeDb(opts);
  const surreal = {
    withCompany: async <T>(_c: string, fn: (d: typeof db) => Promise<T>) => fn(db),
  } as never;
  const embedder = {
    embedManyForWrite: async (texts: string[]) => {
      if (opts.failingTexts?.some((t) => texts.some((x) => x.includes(t)))) {
        throw new Error('embed batch refused');
      }
      return texts.map(() => [1, 2, 3]);
    },
    activeSpaceId: () => 'openai:text-embedding-3-small:1536:l2',
    cacheStats: () => ({ provider: 'openai:text-embedding-3-small:1536' }),
  } as never;
  const config = {
    get: (k: string, def?: string) => (k === 'REINDEX_BATCH_SIZE' ? '200' : def),
  } as never;
  return { engine: new ReindexEngineService(surreal, embedder, config), calls };
}

const FACT_PAGE = [{ id: 'knowledge_fact:1', predicate: 'status', object: 'active' }];
const SCENE_PAGE = [
  { id: 'memory_episode:1', gist: 'scene one' },
  { id: 'memory_episode:2', gist: 'scene two' },
];
const OPTS = { dryRun: false, remaining: 1000 };

describe('ReindexEngineService — terminal status per tenant', () => {
  it('a clean default sweep is complete with knowledge_fact as its one unit', async () => {
    const { engine } = makeEngine({ pages: { knowledge_fact: FACT_PAGE } });
    const res = await engine.reindexTenant('co_x', OPTS);
    expect(res.factsUpdated).toBe(1);
    expect(res).not.toHaveProperty('tables');
    expect(res.outcome).toEqual({
      status: 'complete',
      total: 1,
      succeeded: 1,
      failed: [],
      degradedBy: [],
    });
  });

  it('an embed batch the embedder refuses fails the table — the only table ⇒ failed', async () => {
    const { engine } = makeEngine({
      pages: { knowledge_fact: FACT_PAGE },
      failingTexts: ['status: active'],
    });
    const res = await engine.reindexTenant('co_x', OPTS);
    expect(res.factsUpdated).toBe(0);
    expect(res.outcome.status).toBe('failed');
    expect(res.outcome.failed).toEqual([
      { key: 'knowledge_fact', error: '1 page(s) failed to embed, 0 row write(s) failed' },
    ]);
  });

  it('a row write that fails degrades the sweep and names the table', async () => {
    const { engine } = makeEngine({
      pages: { knowledge_fact: FACT_PAGE, memory_episode: SCENE_PAGE },
      failingRows: ['memory_episode:2'],
    });
    const res = await engine.reindexTenant('co_x', { ...OPTS, allTables: true });
    expect(res.outcome.status).toBe('degraded');
    expect(res.outcome.total).toBe(7);
    expect(res.outcome.failed).toEqual([
      { key: 'memory_episode', error: '0 page(s) failed to embed, 1 row write(s) failed' },
    ]);
    expect(res.tables?.find((t) => t.table === 'memory_episode')).toEqual({
      table: 'memory_episode',
      scanned: 2,
      updated: 1,
    });
  });

  it('retry with `tables` sweeps exactly those tables — knowledge_fact is not touched', async () => {
    const { engine, calls } = makeEngine({
      pages: { knowledge_fact: FACT_PAGE, memory_episode: SCENE_PAGE },
    });
    const res = await engine.reindexTenant('co_x', { ...OPTS, tables: ['memory_episode'] });
    const selects = calls.filter((c) => /^\s*SELECT/.test(c.sql)).map((c) => c.sql);
    expect(selects.some((s) => s.includes('FROM knowledge_fact'))).toBe(false);
    expect(selects.some((s) => s.includes('FROM memory_episode'))).toBe(true);
    expect(res.factsScanned).toBe(0);
    expect(res.tables).toEqual([{ table: 'memory_episode', scanned: 2, updated: 2 }]);
    expect(res.outcome).toMatchObject({ status: 'complete', total: 1, succeeded: 1 });
  });
});

describe('ReindexEmbeddingsService — roster fold', () => {
  function makeRoster(
    perTenant: Record<string, () => Promise<{ factsScanned: number; factsUpdated: number }>>,
  ) {
    const apiKeys = { fanOutRoster: () => Object.keys(perTenant) } as unknown as ApiKeyService;
    const engine = {
      providerId: () => 'stub',
      reindexTenant: async (companyId: string) => {
        const r = await perTenant[companyId]!();
        return {
          ...r,
          outcome: { status: 'complete', total: 1, succeeded: 1, failed: [], degradedBy: [] },
        };
      },
    } as unknown as ReindexEngineService;
    return new ReindexEmbeddingsService(apiKeys, engine);
  }

  it('a tenant that throws is a failed unit keyed by companyId; the rest still count', async () => {
    const svc = makeRoster({
      co_a: async () => ({ factsScanned: 2, factsUpdated: 2 }),
      co_b: async () => {
        throw new Error('pool exhausted');
      },
    });
    const res = await svc.run({});
    expect(res.factsUpdated).toBe(2);
    expect(res.outcome.status).toBe('degraded');
    expect(res.outcome.failed).toEqual([
      {
        key: 'co_b',
        error: 'failed: 0 of 0 unit(s) succeeded (1 failed); first: * — pool exhausted',
      },
    ]);
  });

  it('every tenant throwing ⇒ failed', async () => {
    const svc = makeRoster({
      co_a: async () => {
        throw new Error('down');
      },
    });
    const res = await svc.run({});
    expect(res.outcome.status).toBe('failed');
  });
});
