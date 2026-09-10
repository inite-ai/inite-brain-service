import { VectorCorpusService } from '../src/admin/vector-corpus.service';
import { VECTOR_COLUMNS } from '../src/ai/embedder/embedding-space';

/**
 * The census classifies and counts; the reconcile decides. Both are pinned
 * here on a stub store so the rules are explicit:
 *   - a row is non-conforming when its width is not the primary embedder's,
 *     whatever its embeddingSpaceId says;
 *   - only columns the reindex sweep owns are repairable, the rest are
 *     producer-owned and reported;
 *   - repair runs the sweep once per tenant, records a job run, and is
 *     deferred (not skipped) while the primary embedder is still warming.
 */
describe('VectorCorpusService', () => {
  type Census = Record<string, Array<{ width: number; spaceId?: string | null; count: number }>>;

  function make(opts: {
    census: Census;
    ready?: boolean;
    afterRepair?: Census;
    dimension?: number;
  }) {
    let census = opts.census;
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        const m = /FROM (\w+)\s+WHERE (\w+) != NONE/.exec(sql);
        if (!m) return [[]];
        const rows = census[`${m[1]}.${m[2]}`] ?? [];
        return [rows.map((r) => ({ count: r.count, width: r.width, spaceId: r.spaceId ?? null }))];
      },
    };
    const surreal = {
      withCompany: (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
      onTenantSchemaReady: jest.fn(),
    };
    const embedder = {
      primaryDimensions: () => opts.dimension ?? 1024,
      primarySpaceId: () => 'bge-m3:Xenova/bge-m3:1024',
      isReady: () => opts.ready ?? true,
    };
    const reindex = {
      run: jest.fn(async () => {
        if (opts.afterRepair) census = opts.afterRepair;
        return {
          factsScanned: 40,
          factsUpdated: 39,
          tables: [],
          outcome: { status: 'complete', total: 7, succeeded: 7, failed: [], degradedBy: [] },
        };
      }),
    };
    const jobs = {
      start: jest.fn(async (input: unknown) => ({ runId: 'r1', ...(input as object) })),
      finish: jest.fn(async () => undefined),
    };
    const metrics = {
      setVectorCorpusNonconforming: jest.fn(),
      setVectorCorpusTenantsNonconforming: jest.fn(),
      countVectorCorpusRepair: jest.fn(),
    };
    const apiKeys = { fanOutRoster: () => ['co_x'] };
    const svc = new VectorCorpusService(
      surreal as never,
      embedder as never,
      reindex as never,
      apiKeys as never,
      jobs as never,
      metrics as never,
    );
    return { svc, reindex, jobs, metrics, queries };
  }

  it('counts every declared column, by width and space, against the primary width', async () => {
    const { svc, queries } = make({
      census: {
        'knowledge_fact.embedding': [
          { width: 1536, spaceId: null, count: 39 },
          { width: 1024, spaceId: 'bge-m3:Xenova/bge-m3:1024', count: 3 },
        ],
        'lens_suppression.centroid': [{ width: 1536, spaceId: 'openai:x:1536', count: 2 }],
      },
    });
    const inv = await svc.inventory('co_x');
    expect(inv.columns).toHaveLength(VECTOR_COLUMNS.length);
    expect(queries).toHaveLength(VECTOR_COLUMNS.length);
    const facts = inv.columns.find((c) => c.table === 'knowledge_fact' && c.field === 'embedding')!;
    expect(facts).toMatchObject({ repair: 'reindex', rows: 42, conforming: 3, nonConforming: 39 });
    expect(facts.byWidth).toEqual([
      { width: 1024, spaceId: 'bge-m3:Xenova/bge-m3:1024', count: 3 },
      { width: 1536, spaceId: null, count: 39 },
    ]);
    const centroid = inv.columns.find((c) => c.table === 'lens_suppression')!;
    expect(centroid).toMatchObject({ repair: 'producer', nonConforming: 2 });
    expect(inv).toMatchObject({
      dimension: 1024,
      nonConforming: 41,
      repairable: 39,
      producerOwned: 2,
    });
  });

  it('a row in the right width is conforming even without a space stamp; a stamped row of the wrong width is not', async () => {
    const { svc } = make({
      census: {
        'knowledge_entity.embedding': [
          { width: 1024, spaceId: null, count: 5 },
          { width: 1024, spaceId: 'openai:text-embedding-3-small:1536', count: 1 },
          { width: 1536, spaceId: 'bge-m3:Xenova/bge-m3:1024', count: 1 },
        ],
      },
    });
    const inv = await svc.inventory('co_x');
    const ent = inv.columns.find((c) => c.table === 'knowledge_entity')!;
    // Width is the contract the cosine enforces; the stamp is bookkeeping.
    expect(ent).toMatchObject({ conforming: 6, nonConforming: 1 });
  });

  it('repairs a repairable corpus with one sweep for that tenant, recorded as a reindex job run', async () => {
    const { svc, reindex, jobs, metrics } = make({
      census: { 'knowledge_fact.embedding': [{ width: 1536, count: 39 }] },
      afterRepair: { 'knowledge_fact.embedding': [{ width: 1024, count: 39 }] },
    });
    const r = await svc.reconcileTenant('co_x', 'startup');
    expect(r.outcome).toBe('repaired');
    expect(reindex.run).toHaveBeenCalledTimes(1);
    // The sweep is narrowed to the rows the census just counted: without
    // `widthMismatchOnly` one stray vector costs a full-tenant re-embed.
    expect(reindex.run).toHaveBeenCalledWith({
      tenant: 'co_x',
      allTables: true,
      widthMismatchOnly: { dim: 1024 },
    });
    expect(jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'reindex_embeddings',
        companyId: 'co_x',
        triggeredBy: 'startup',
        initialProgress: expect.objectContaining({
          reason: 'vector_corpus_repair',
          repairable: 39,
        }),
      }),
    );
    expect(jobs.finish).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r1' }),
      expect.objectContaining({
        status: 'succeeded',
        result: expect.objectContaining({ nonConformingBefore: 39, nonConformingAfter: 0 }),
      }),
    );
    expect(r.after?.nonConforming).toBe(0);
    expect(metrics.countVectorCorpusRepair).toHaveBeenCalledWith('repaired');
  });

  it('does not sweep for producer-owned rows alone — they are reported, not re-embedded', async () => {
    const { svc, reindex, jobs } = make({
      census: { 'community_node.summaryEmbedding': [{ width: 1536, count: 4 }] },
    });
    const r = await svc.reconcileTenant('co_x', 'cron');
    expect(r.outcome).toBe('nothing_to_repair');
    expect(r.before.producerOwned).toBe(4);
    expect(reindex.run).not.toHaveBeenCalled();
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it('defers, never skips, while the primary embedder is not ready — the fallback would write the wrong width', async () => {
    const { svc, reindex, metrics } = make({
      census: { 'knowledge_fact.embedding': [{ width: 1536, count: 39 }] },
      ready: false,
    });
    const r = await svc.reconcileTenant('co_x', 'startup');
    expect(r.outcome).toBe('embedder_not_ready');
    expect(reindex.run).not.toHaveBeenCalled();
    expect(metrics.countVectorCorpusRepair).toHaveBeenCalledWith('deferred');
  });

  it('a repair deferred at boot runs by itself once the embedder is warm — not the next night', async () => {
    jest.useFakeTimers();
    try {
      let ready = false;
      const { svc, reindex } = make({
        census: { 'knowledge_fact.embedding': [{ width: 1536, count: 39 }] },
        afterRepair: { 'knowledge_fact.embedding': [{ width: 1024, count: 39 }] },
      });
      (svc as unknown as { embedder: { isReady: () => boolean } }).embedder.isReady = () => ready;
      const first = await svc.reconcileTenant('co_x', 'startup');
      expect(first.outcome).toBe('embedder_not_ready');
      expect(reindex.run).not.toHaveBeenCalled();
      // Two checks while still warming: nothing happens.
      await jest.advanceTimersByTimeAsync(2 * 60_000);
      expect(reindex.run).not.toHaveBeenCalled();
      // Warm now: the next check re-queues the tenant and the sweep runs.
      ready = true;
      await jest.advanceTimersByTimeAsync(60_000);
      await jest.advanceTimersByTimeAsync(0);
      expect(reindex.run).toHaveBeenCalledTimes(1);
      expect(reindex.run).toHaveBeenCalledWith({
        tenant: 'co_x',
        allTables: true,
        widthMismatchOnly: { dim: 1024 },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a deferral on the nightly pass does not start a poller — the next night retries', async () => {
    jest.useFakeTimers();
    try {
      const { svc, reindex } = make({
        census: { 'knowledge_fact.embedding': [{ width: 1536, count: 39 }] },
        ready: false,
      });
      await svc.reconcileTenant('co_x', 'cron');
      await jest.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(reindex.run).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a conforming corpus is a no-op: no sweep, no job run', async () => {
    const { svc, reindex, jobs } = make({
      census: { 'knowledge_fact.embedding': [{ width: 1024, count: 40 }] },
    });
    const r = await svc.reconcileTenant('co_x', 'cron');
    expect(r.outcome).toBe('nothing_to_repair');
    expect(reindex.run).not.toHaveBeenCalled();
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it('a failed sweep is recorded as a failed job run and reported, not thrown', async () => {
    const { svc, jobs, metrics } = make({
      census: { 'knowledge_fact.embedding': [{ width: 1536, count: 39 }] },
    });
    const boom = new Error('embedder exploded');
    (svc as unknown as { reindex: { run: jest.Mock } }).reindex.run.mockRejectedValueOnce(boom);
    const r = await svc.reconcileTenant('co_x', 'manual');
    expect(r.outcome).toBe('failed');
    expect(r.error).toBe('embedder exploded');
    expect(jobs.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ message: 'embedder exploded' }),
      }),
    );
    expect(metrics.countVectorCorpusRepair).toHaveBeenCalledWith('failed');
  });

  it('the nightly pass publishes per-column totals and the tenant count', async () => {
    const { svc, metrics } = make({
      census: { 'knowledge_fact.embedding': [{ width: 1536, count: 2 }] },
      ready: false,
    });
    await svc.reconcileAll('cron');
    expect(metrics.setVectorCorpusNonconforming).toHaveBeenCalledWith(
      'knowledge_fact',
      'embedding',
      2,
    );
    expect(metrics.setVectorCorpusNonconforming).toHaveBeenCalledWith(
      'knowledge_entity',
      'embedding',
      0,
    );
    expect(metrics.setVectorCorpusTenantsNonconforming).toHaveBeenCalledWith(1);
  });
  describe('the schema-ready hook runs under a per-tenant lease', () => {
    const flush = async () => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    };
    function guarded(opts: Parameters<typeof make>[0] & { held?: boolean }) {
      const made = make(opts);
      const calls: Array<{ key: string; ttl: number | undefined }> = [];
      const guard = {
        run: jest.fn(async (key: string, fn: () => Promise<unknown>, ttl?: number) => {
          calls.push({ key, ttl });
          return opts.held ? null : fn();
        }),
      };
      Object.assign(made.svc, { guard });
      return { ...made, calls };
    }

    it('one tenant, one lease: vector_corpus_startup_<tenant>, 30 min, and the repair runs under it', async () => {
      const { svc, reindex, calls } = guarded({
        census: { 'knowledge_fact.embedding': [{ width: 1536, count: 39 }] },
        afterRepair: { 'knowledge_fact.embedding': [{ width: 1024, count: 39 }] },
      });
      svc.noteTenant('co_x');
      await flush();
      expect(calls).toEqual([{ key: 'vector_corpus_startup_co_x', ttl: 30 * 60 }]);
      expect(reindex.run).toHaveBeenCalledTimes(1);
    });

    it('a replica that finds the lease held skips: no census, no sweep, no job run', async () => {
      const { svc, reindex, jobs, queries } = guarded({
        census: { 'knowledge_fact.embedding': [{ width: 1536, count: 39 }] },
        held: true,
      });
      svc.noteTenant('co_x');
      await flush();
      expect(queries).toEqual([]);
      expect(reindex.run).not.toHaveBeenCalled();
      expect(jobs.start).not.toHaveBeenCalled();
    });

    it('a deferred repair re-enters through the same lease once the embedder is warm', async () => {
      jest.useFakeTimers();
      try {
        let ready = false;
        const { svc, reindex, calls } = guarded({
          census: { 'knowledge_fact.embedding': [{ width: 1536, count: 39 }] },
          afterRepair: { 'knowledge_fact.embedding': [{ width: 1024, count: 39 }] },
        });
        (svc as unknown as { embedder: { isReady: () => boolean } }).embedder.isReady = () => ready;
        svc.noteTenant('co_x');
        await jest.advanceTimersByTimeAsync(0);
        // Deferred under the lease, and the lease was released with it.
        expect(calls).toHaveLength(1);
        expect(reindex.run).not.toHaveBeenCalled();
        ready = true;
        await jest.advanceTimersByTimeAsync(60_000);
        await jest.advanceTimersByTimeAsync(0);
        expect(calls).toEqual([
          { key: 'vector_corpus_startup_co_x', ttl: 30 * 60 },
          { key: 'vector_corpus_startup_co_x', ttl: 30 * 60 },
        ]);
        expect(reindex.run).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
