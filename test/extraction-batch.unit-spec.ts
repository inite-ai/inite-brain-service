import { ExtractionBatchService } from '../src/documents/extraction-batch.service';

/**
 * When the batch pass runs. A held conversation asks for a pass when it
 * goes quiet and a failed pass for its backed-off retry: the job must not
 * become visible before that — a boundary aligned to the delay itself
 * could fire a two-minute hold within seconds.
 */
describe('ExtractionBatchService.schedule', () => {
  const enqueued: Array<{ dedupKey: string; visibleAfter: Date }> = [];
  const claim = {
    enqueue: async (e: { dedupKey: string; visibleAfter: Date }) => {
      enqueued.push(e);
      return { runId: 'r', created: true };
    },
  };
  const svc = new ExtractionBatchService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined,
    claim as never,
  );

  // A fixed clock, 7 s into a 20 s window: no call straddles a boundary.
  const NOW = 1_790_000_007_000;
  beforeEach(() => {
    enqueued.length = 0;
    process.env.EXTRACTION_BATCH_WINDOW_SECONDS = '20';
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => delete process.env.EXTRACTION_BATCH_WINDOW_SECONDS);

  it('a delayed pass is never visible before its delay', async () => {
    const now = NOW;
    await svc.schedule('co', { delayMs: 120_000 });
    await svc.schedule('co', { retry: 1, delayMs: 300_000 });
    expect(enqueued[0]!.visibleAfter.getTime()).toBeGreaterThanOrEqual(now + 120_000);
    expect(enqueued[1]!.visibleAfter.getTime()).toBeGreaterThanOrEqual(now + 300_000);
    expect(enqueued[1]!.dedupKey).toMatch(/^xdoc_r1_/);
  });

  it('the captures of one window ask for one job, at its end', async () => {
    await svc.schedule('co');
    await svc.schedule('co');
    expect(enqueued[0]!.dedupKey).toBe(enqueued[1]!.dedupKey);
    expect(enqueued[0]!.visibleAfter.getTime()).toBe(1_790_000_020_000);
  });
});

describe('ExtractionBatchService pass', () => {
  const doc = (id: string, minute: number) => ({
    id,
    occurredAt: new Date(Date.UTC(2026, 8, 26, 10, minute)),
    chunkCount: 1,
    meta: {},
    status: 'indexing',
  });

  it('reads groups concurrently, retries a conflicted commit, and a failed commit does not fail the pass', async () => {
    const docs = new Map([
      ['source_document:a', doc('source_document:a', 1)],
      ['source_document:b', doc('source_document:b', 2)],
      ['source_document:c', doc('source_document:c', 3)],
    ]);
    let listed = false;
    const candidates = {
      listAwaitingRuns: async () => {
        if (listed) return [];
        listed = true;
        return [...docs.keys()].map((docId) => ({ docId, arrivedAt: new Date(0) }));
      },
    };
    const store = {
      getById: async (_c: string, id: string) => docs.get(id) ?? null,
      getChunks: async () => [{ seq: 0, text: 'x', charStart: 0, charEnd: 1 }],
      setStatus: async () => undefined,
    };
    let inFlight = 0;
    let peak = 0;
    const runs = {
      runGeneral: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return { status: 'succeeded' };
      },
    };
    const attempts = new Map<string, number>();
    const order: string[] = [];
    const commit = {
      commitIfRunsSettled: async (_c: string, d: { id: string }) => {
        const n = (attempts.get(d.id) ?? 0) + 1;
        attempts.set(d.id, n);
        if (d.id === 'source_document:a' && n === 1) {
          throw new Error('Transaction conflict: Resource busy. This transaction can be retried');
        }
        if (d.id === 'source_document:b') throw new Error('boom');
        order.push(d.id);
        return { committed: true, deferred: false, entityIds: [], factIds: [], edgeIds: [] };
      },
    };
    const pass = new ExtractionBatchService(
      store as never,
      candidates as never,
      runs as never,
      commit as never,
    );
    const out = await pass.runPass('co', { force: true });
    expect(out).toMatchObject({ read: 3, failed: 0, committed: 2 });
    expect(attempts.get('source_document:a')).toBe(2);
    expect(order).toEqual(['source_document:a', 'source_document:c']);
    expect(peak).toBeGreaterThan(1);
  });
});
