/**
 * A contract re-read survives a provider outage: a document whose run
 * fails is that document's failure, the walk goes on, and a backed-off
 * retry pass is enqueued (the ledger reopens failed runs). Measured on
 * production 2026-09-25: every document of a re-read failed inside an
 * OpenAI credit outage, the job threw on the first one, burned its
 * attempts, and its stable dedup key kept it from ever running again.
 */
import { DocumentReindexService } from '../src/documents/document-reindex.service';

type Enqueued = { dedupKey?: string; payload?: Record<string, unknown>; visibleAfter?: Date };

function make(runOne: (docId: string) => Promise<{ status: string }>) {
  const enqueued: Enqueued[] = [];
  const store = {
    listReindexable: async () => [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }],
    getChunks: async () => [{ seq: 0, text: 't' }],
  };
  const dispatch = { runOne: ({ doc }: { doc: { id: string } }) => runOne(doc.id) };
  const commit = { commitIfRunsSettled: async () => undefined };
  const claim = {
    enqueue: async (e: Enqueued) => {
      enqueued.push(e);
      return { runId: 'r', created: true };
    },
  };
  const svc = new DocumentReindexService(
    store as never,
    dispatch as never,
    commit as never,
    undefined,
    claim as never,
  );
  const run = (payload: Record<string, unknown>) =>
    (
      svc as unknown as { executeFromQueue: (c: unknown) => Promise<Record<string, unknown>> }
    ).executeFromQueue({
      companyId: 'co',
      payload,
      abortSignal: new AbortController().signal,
    });
  return { run, enqueued };
}

describe('document reindex under provider failures', () => {
  it('walks past a failed document and schedules one backed-off retry pass', async () => {
    const { run, enqueued } = make(async (id) => {
      if (id === 'd2') throw new Error('429 no credits');
      return { status: 'succeeded' };
    });
    const t0 = Date.now();
    const out = await run({ packId: '_general', packVersion: '2' });
    expect(out).toMatchObject({ processed: 2, failed: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.dedupKey).toBe('reindex__general_2_retry1_start');
    expect(enqueued[0]!.payload).toMatchObject({ retry: 1 });
    expect(enqueued[0]!.visibleAfter!.getTime()).toBeGreaterThanOrEqual(t0 + 15 * 60_000);
  });

  it('a clean pass schedules nothing; retries stop at the bound', async () => {
    const clean = make(async () => ({ status: 'succeeded' }));
    await clean.run({ packId: '_general', packVersion: '2' });
    expect(clean.enqueued).toHaveLength(0);

    const failing = make(async () => {
      throw new Error('500');
    });
    const out = await failing.run({ packId: '_general', packVersion: '2', retry: 5 });
    expect(out).toMatchObject({ failed: 3 });
    expect(failing.enqueued).toHaveLength(0);
  });
});
