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
  const doc = (id: string, minute: number, userId?: string) => ({
    id,
    occurredAt: new Date(Date.UTC(2026, 8, 26, 10, minute)),
    chunkCount: 1,
    meta: {},
    status: 'indexing',
    ...(userId ? { userId } : {}),
  });

  function harness(
    docs: Map<string, ReturnType<typeof doc>>,
    commitImpl?: (id: string, n: number) => void,
  ) {
    let listed = false;
    const events: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const attempts = new Map<string, number>();
    const pass = new ExtractionBatchService(
      {
        getById: async (_c: string, id: string) => docs.get(id) ?? null,
        getChunks: async () => [{ seq: 0, text: 'x', charStart: 0, charEnd: 1 }],
        setStatus: async () => undefined,
      } as never,
      {
        listAwaitingRuns: async () => {
          if (listed) return [];
          listed = true;
          return [...docs.keys()].map((docId) => ({ docId, arrivedAt: new Date(0) }));
        },
      } as never,
      {
        runGeneral: async (p: { doc: { id: string } }) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          events.push(`read ${p.doc.id}`);
          await new Promise((r) => setTimeout(r, 10));
          inFlight -= 1;
          return { status: 'succeeded' };
        },
      } as never,
      {
        commitIfRunsSettled: async (_c: string, d: { id: string }) => {
          const n = (attempts.get(d.id) ?? 0) + 1;
          attempts.set(d.id, n);
          commitImpl?.(d.id, n);
          events.push(`commit ${d.id}`);
          return { committed: true, deferred: false, entityIds: [], factIds: [], edgeIds: [] };
        },
      } as never,
    );
    return { pass, events, attempts, peak: () => peak };
  }

  it('reads one scope in order, committing each document before the next is read', async () => {
    const h = harness(
      new Map([
        ['source_document:b', doc('source_document:b', 2)],
        ['source_document:a', doc('source_document:a', 1)],
      ]),
    );
    await h.pass.runPass('co', { force: true });
    // The later document is read against the earlier one's committed facts.
    expect(h.events).toEqual([
      'read source_document:a',
      'commit source_document:a',
      'read source_document:b',
      'commit source_document:b',
    ]);
  });

  it('reads different scopes concurrently', async () => {
    const h = harness(
      new Map([
        ['source_document:u1', doc('source_document:u1', 1, 'u1')],
        ['source_document:u2', doc('source_document:u2', 1, 'u2')],
        ['source_document:g', doc('source_document:g', 1)],
      ]),
    );
    expect(await h.pass.runPass('co', { force: true })).toMatchObject({ read: 3, committed: 3 });
    expect(h.peak()).toBeGreaterThan(1);
  });

  it('retries a conflicted commit, and a failed commit does not fail the pass', async () => {
    const h = harness(
      new Map([
        ['source_document:a', doc('source_document:a', 1)],
        ['source_document:b', doc('source_document:b', 2)],
        ['source_document:c', doc('source_document:c', 3)],
      ]),
      (id, n) => {
        if (id === 'source_document:a' && n === 1) {
          throw new Error('Transaction conflict: Resource busy. This transaction can be retried');
        }
        if (id === 'source_document:b') throw new Error('boom');
      },
    );
    expect(await h.pass.runPass('co', { force: true })).toMatchObject({
      read: 3,
      failed: 0,
      committed: 2,
    });
    expect(h.attempts.get('source_document:a')).toBe(2);
    expect(h.events.filter((e) => e.startsWith('commit'))).toEqual([
      'commit source_document:a',
      'commit source_document:c',
    ]);
  });
});
