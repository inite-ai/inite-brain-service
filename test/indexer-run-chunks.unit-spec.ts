/**
 * The read of one document's chunks (IndexerRunService.runIndexer):
 *  - chunks are read at once (bounded), all staged on the one run;
 *  - a failed chunk fails the run only after every read has settled;
 * and the queued pack read (DedicatedExtractorService, background):
 *  - asks for the offline tier, and throws on a failed call instead of
 *    reading as an empty document.
 */
import { IndexerRunService } from '../src/documents/indexer-run.service';
import { DedicatedExtractorService } from '../src/indexers/dedicated-extractor.service';

function makeRuns() {
  const inserted: number[] = [];
  const finalized: Array<{ status: string }> = [];
  const candidates = {
    createRun: jest.fn(async () => ({ created: true, runId: 'indexer_run:r1' })),
    insertBatch: jest.fn(async (_c: string, p: { chunkSeq: number }) => {
      inserted.push(p.chunkSeq);
      return { entities: 1, facts: 1, relations: 0 };
    }),
    finalizeRun: jest.fn(async (_c: string, p: { status: string }) => {
      finalized.push({ status: p.status });
    }),
  };
  const svc = new IndexerRunService({} as never, candidates as never, {} as never);
  return { svc, inserted, finalized };
}

const spec = (extract: (text: string) => Promise<unknown>, n = 6) => ({
  companyId: 'co',
  doc: { id: 'source_document:d1' } as never,
  chunks: Array.from({ length: n }, (_, i) => ({
    seq: i,
    text: `c${i}`,
    charStart: 0,
    charEnd: 2,
  })),
  packId: '_general',
  packVersion: '1',
  executionMode: 'virtual' as const,
  model: 'm',
  extract: extract as never,
});

describe('IndexerRunService.runIndexer reads a document’s chunks at once', () => {
  it('overlaps the reads (bounded) and stages every chunk on the run', async () => {
    const { svc, inserted, finalized } = makeRuns();
    let inFlight = 0;
    let peak = 0;
    const res = await svc.runIndexer(
      spec(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return { entities: [], facts: [], edges: [] };
      }),
    );
    expect(res.status).toBe('succeeded');
    expect(res.stats?.chunks).toBe(6);
    expect([...inserted].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(finalized).toEqual([{ status: 'succeeded' }]);
  });

  it('fails the run once every read has settled', async () => {
    const { svc, inserted, finalized } = makeRuns();
    const run = svc.runIndexer(
      spec(async (text) => {
        if (text === 'c0') throw new Error('provider down');
        await new Promise((r) => setTimeout(r, 10));
        return { entities: [], facts: [], edges: [] };
      }, 3),
    );
    await expect(run).rejects.toThrow('provider down');
    // The slow chunks finished staging before the run was finalized.
    expect([...inserted].sort()).toEqual([1, 2]);
    expect(finalized).toEqual([{ status: 'failed' }]);
  });
});

describe('DedicatedExtractorService — a queued read', () => {
  const make = (result: unknown) => {
    const runs: Array<{ overrides?: { tier?: string } }> = [];
    const runner = {
      scPasses: 1,
      modelId: () => 'm',
      run: jest.fn(async (a: { overrides?: { tier?: string } }) => {
        runs.push(a);
        return result;
      }),
    };
    const registry = {
      getSnapshot: jest.fn(async () => ({
        versionHash: 'v',
        active: [],
        aliasMap: new Map(),
        embeddings: new Map(),
      })),
    };
    const cache = { computeKey: () => 'k', get: () => undefined, set: jest.fn() };
    const svc = new DedicatedExtractorService(registry as never, runner as never, cache as never);
    return { svc, runs };
  };

  afterEach(() => delete process.env.OPENAI_OFFLINE_SERVICE_TIER);

  it('asks for the offline tier', async () => {
    process.env.OPENAI_OFFLINE_SERVICE_TIER = 'flex';
    const { svc, runs } = make({ entities: [], facts: [], edges: [] });
    await svc.extract({ text: 't', companyId: 'co', packId: 'p', background: true });
    expect(runs[0]?.overrides?.tier).toBe('flex');
    await svc.extract({ text: 't2', companyId: 'co', packId: 'p' });
    expect(runs[1]?.overrides?.tier).toBeUndefined();
  });

  it('throws on a failed call; an inline read still answers empty', async () => {
    const { svc } = make(null);
    await expect(
      svc.extract({ text: 't', companyId: 'co', packId: 'p', background: true }),
    ).rejects.toThrow('transient LLM failure');
    await expect(svc.extract({ text: 't', companyId: 'co', packId: 'p' })).resolves.toEqual({
      entities: [],
      facts: [],
      edges: [],
    });
  });
});
