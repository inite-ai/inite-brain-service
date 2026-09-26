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
