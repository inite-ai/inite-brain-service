/**
 * The raw-first pipeline's remaining seams, collaborators stubbed:
 *  - IndexerDispatchService.runOne (a queued read: jobs, re-index) reads
 *    in the background — general and dedicated alike; an external pack is
 *    planned, not read; dispatchSync isolates a failing dedicated pack;
 *  - IndexerRunService.keepRaw closes a run `skipped` at depth raw;
 *  - CandidateStoreService: the pass lists what it has not taken, asked-
 *    for first; a promotion reopens raw-kept runs and moves waiting ones
 *    up, by documents or by conversation of one scope;
 *  - EpisodeReadStoreService.pendingTurns reads the asker's and the
 *    tenant's waiting documents, newest first;
 *  - CandidateSweeperService.reconcileRuns schedules the reader's retry
 *    pass;
 *  - ExtractionAdminController drains with force (and retry on request);
 *  - ExtractionMetrics counts depth and promotions.
 */
import { Registry } from 'prom-client';
import { IndexerDispatchService } from '../src/documents/indexer-dispatch.service';
import { IndexerRunService } from '../src/documents/indexer-run.service';
import { CandidateStoreService } from '../src/documents/candidate-store.service';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import { CandidateSweeperService } from '../src/documents/candidate-sweeper.service';
import { ExtractionAdminController } from '../src/documents/extraction-admin.controller';
import { ExtractionMetrics } from '../src/documents/extraction.metrics';

const doc = { id: 'source_document:d1', vertical: 'chat', meta: {} } as never;
const chunks = [{ seq: 0, text: 't', charStart: 0, charEnd: 1 }];

describe('IndexerDispatchService', () => {
  function make(binding: { indexerId: string; mode?: string; packVersion?: string }) {
    const calls: Array<{ kind: string; p: Record<string, unknown> }> = [];
    const runs = {
      runGeneral: async (p: Record<string, unknown>) => {
        calls.push({ kind: 'general', p });
        return { status: 'succeeded' };
      },
      runIndexer: async (p: { extract: (t: string) => Promise<unknown> }) => {
        await p.extract('t');
        return { status: 'succeeded' };
      },
      planExternal: async () => ({ runId: '', packId: binding.indexerId, status: 'planned' }),
    };
    const dedicated = {
      modelId: () => 'm',
      extract: async (p: Record<string, unknown>) => {
        calls.push({ kind: 'dedicated', p });
        return { entities: [], facts: [], edges: [] };
      },
    };
    const router = {
      bindingsFor: async () => [{ packVersion: '1', mode: 'dedicated', ...binding }],
    };
    const webhook = { notify: () => undefined, hint: () => undefined };
    const svc = new IndexerDispatchService(
      router as never,
      runs as never,
      dedicated as never,
      webhook as never,
    );
    return { svc, calls };
  }

  it('a queued general read runs in the background', async () => {
    const { svc, calls } = make({ indexerId: 'x' });
    await svc.runOne({ companyId: 'co', doc, chunks, packId: '_general' });
    expect(calls).toEqual([{ kind: 'general', p: expect.objectContaining({ background: true }) }]);
  });

  it('a queued pack read runs in the background (offline tier, a failed call fails the run)', async () => {
    const { svc, calls } = make({ indexerId: 'legal' });
    await svc.runOne({ companyId: 'co', doc, chunks, packId: 'legal' });
    expect(calls).toEqual([
      { kind: 'dedicated', p: expect.objectContaining({ packId: 'legal', background: true }) },
    ]);
  });

  it('an external pack is planned, never read in-process; an unknown pack throws', async () => {
    const ext = make({ indexerId: 'remote', mode: 'external' });
    const r = await ext.svc.runOne({ companyId: 'co', doc, chunks, packId: 'remote' });
    expect(r.status).toBe('planned');
    expect(ext.calls).toEqual([]);
    await expect(ext.svc.runOne({ companyId: 'co', doc, chunks, packId: 'nope' })).rejects.toThrow(
      'unknown indexer pack',
    );
  });
});

describe('IndexerRunService.keepRaw', () => {
  it('claims the generalist run and closes it skipped at depth raw — no extraction', async () => {
    const finalized: Array<Record<string, unknown>> = [];
    const candidates = {
      createRun: async () => ({ created: true, runId: 'indexer_run:r' }),
      finalizeRun: async (_c: string, p: Record<string, unknown>) => {
        finalized.push(p);
      },
    };
    const extractor = {
      modelId: () => 'm',
      extractBackground: jest.fn(),
      extract: jest.fn(),
    };
    const svc = new IndexerRunService(extractor as never, candidates as never, {} as never);
    const r = await svc.keepRaw({ companyId: 'co', doc: { id: 'source_document:d1' } as never });
    expect(r.status).toBe('skipped');
    expect(finalized).toEqual([
      expect.objectContaining({
        status: 'skipped',
        stats: expect.objectContaining({ depth: 'raw' }),
      }),
    ]);
    expect(extractor.extractBackground).not.toHaveBeenCalled();
    // A run another worker already holds is left to it.
    const held = new IndexerRunService(
      extractor as never,
      { createRun: async () => ({ created: false, runId: 'indexer_run:r' }) } as never,
      {} as never,
    );
    expect((await held.keepRaw({ companyId: 'co', doc: { id: 'd' } as never })).status).toBe(
      'skipped',
    );
  });
});

function captureDb(result: unknown[] = [[], []]) {
  const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const db = {
    query: async (sql: string, params: Record<string, unknown>) => {
      queries.push({ sql, params });
      return result;
    },
  };
  const surreal = { withCompany: async (_c: string, fn: (d: unknown) => unknown) => fn(db) };
  return { surreal, queries };
}

describe('CandidateStoreService — the reader queue', () => {
  it('lists asked-for first, then by when it happened, without what the pass took', async () => {
    const { surreal, queries } = captureDb([
      [{ docId: 'source_document:a', createdAt: '2026-09-26T10:00:00Z', priority: 2 }],
    ]);
    const store = new CandidateStoreService(surreal as never);
    const out = await store.listAwaitingRuns('co', {
      packId: '_general',
      packVersion: 'v',
      includeFailed: false,
      limit: 64,
      exclude: ['source_document:x'],
    });
    expect(out).toEqual([
      { docId: 'source_document:a', arrivedAt: new Date('2026-09-26T10:00:00Z'), priority: 2 },
    ]);
    expect(queries[0]!.sql).toContain('ORDER BY priority DESC, at ASC');
    expect(queries[0]!.sql).toContain('docId NOTINSIDE $exclude');
    expect((queries[0]!.params.exclude as unknown[]).map(String)).toEqual(['source_document:x']);
    expect(queries[0]!.params.statuses).toEqual(['pending']);
  });

  it('promotes by documents: reopens raw-kept runs, moves waiting ones up, never down', async () => {
    const { surreal, queries } = captureDb([['indexer_run:1'], ['indexer_run:2']]);
    const store = new CandidateStoreService(surreal as never);
    const n = await store.promote('co', {
      packId: '_general',
      packVersion: 'v',
      priority: 2,
      target: { docIds: ['source_document:d1'] },
    });
    expect(n).toBe(2);
    const { sql, params } = queries[0]!;
    expect(sql).toContain("status = 'skipped' AND stats.depth = 'raw'");
    expect(sql).toContain("status = 'pending' AND (priority ?? 0) < $p");
    expect(sql).toContain('docId IN $docs');
    expect(params.p).toBe(2);
    expect(
      await store.promote('co', {
        packId: '_general',
        packVersion: 'v',
        priority: 2,
        target: { docIds: [] },
      }),
    ).toBe(0);
  });

  it('promotes by conversation within one scope', async () => {
    const { surreal, queries } = captureDb([[], []]);
    const store = new CandidateStoreService(surreal as never);
    await store.promote('co', {
      packId: '_general',
      packVersion: 'v',
      priority: 1,
      target: { conversationId: 'c1', userId: 'u1' },
    });
    await store.promote('co', {
      packId: '_general',
      packVersion: 'v',
      priority: 1,
      target: { conversationId: 'c1' },
    });
    expect(queries[0]!.sql).toContain('docId.meta.conversationId = $conv AND docId.userId = $u');
    expect(queries[0]!.params).toMatchObject({ conv: 'c1', u: 'u1' });
    expect(queries[1]!.sql).toContain('docId.userId IS NONE');
  });

  it('never reaps a waiting generalist read as stale', async () => {
    const { surreal, queries } = captureDb([[{ c: 0 }], [{ c: 0 }]]);
    const store = new CandidateStoreService(surreal as never);
    await store.reapStaleRuns('co');
    expect(queries[0]!.sql).toContain("(status = 'pending' AND packId != $general)");
    expect(queries[0]!.params.general).toBe('_general');
  });
});

describe('EpisodeReadStoreService.pendingTurns', () => {
  it("reads the asker's and the tenant's waiting documents, newest first", async () => {
    const { surreal, queries } = captureDb([[]]);
    const store = new EpisodeReadStoreService(surreal as never);
    await store.pendingTurns({ companyId: 'co', limit: 5, includePii: false, userId: 'u1' });
    expect(queries[0]!.sql).toContain('(docId.userId IS NONE OR docId.userId = $scopeUserId)');
    expect(queries[0]!.sql).toContain('ORDER BY createdAt DESC');
    expect(queries[0]!.params.scopeUserId).toBe('u1');
    await store.pendingTurns({ companyId: 'co', limit: 5, includePii: false });
    expect(queries[1]!.sql).toContain('docId.userId IS NONE');
    expect(queries[1]!.sql).not.toContain('$scopeUserId');
  });
});

describe('CandidateSweeperService.reconcileRuns', () => {
  it("schedules the reader's retry pass — its safety net", async () => {
    const scheduled: unknown[] = [];
    const candidates = {
      reapStaleRuns: async () => 0,
      findDocsNeedingCommit: async () => [],
    };
    const sweeper = new CandidateSweeperService(
      {} as never,
      {} as never,
      candidates as never,
      undefined,
      undefined,
      undefined,
      { schedule: async (_c: string, p: unknown) => scheduled.push(p) } as never,
    );
    await sweeper.reconcileRuns('co');
    expect(scheduled).toEqual([{ retry: 1 }]);
  });
});

describe('ExtractionAdminController.drain', () => {
  it('reads everything waiting now; retry on request', async () => {
    const passes: unknown[] = [];
    const batch = {
      runPass: async (_c: string, o: unknown) => {
        passes.push(o);
        return { read: 1, failed: 0, committed: 1, retry: 0 };
      },
    };
    const ctl = new ExtractionAdminController(
      batch as never,
      {
        knownCompanyIds: async () => ['co'],
      } as never,
    );
    const req = { brainAuth: { companyId: 'co', scopes: ['brain:admin'] } } as never;
    await ctl.drain(req, {});
    await ctl.drain(req, { retry: true });
    expect(passes).toEqual([
      { retry: 0, force: true },
      { retry: 1, force: true },
    ]);
  });
});

describe('ExtractionMetrics', () => {
  it('counts documents by depth and promotions by reason', async () => {
    const registry = new Registry();
    const m = new ExtractionMetrics({ registry } as never);
    m.depth('raw', 2);
    m.depth('single', 1);
    m.promoted('answer', 1);
    m.promoted('neighbour', 0);
    const text = await registry.metrics();
    expect(text).toContain('brain_extraction_depth_documents_total{depth="raw"} 2');
    expect(text).toContain('brain_extraction_depth_documents_total{depth="single"} 1');
    expect(text).toContain('brain_extraction_promoted_documents_total{reason="answer"} 1');
    expect(text).not.toContain('reason="neighbour"');
  });
});
