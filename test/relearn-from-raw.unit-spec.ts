/**
 * Learning from answers read raw (RelearnFromRawService), collaborators
 * stubbed:
 *  - schedule: one queued lesson per cited turn (at most four), keyed by
 *    turn and question, carrying whether facts carried the answer;
 *  - a turn cited before it was understood (unread, or kept raw) is
 *    promoted — read in full, ahead of the backlog — and nothing else runs;
 *  - a read turn is re-read with the question as focus, unless facts
 *    carried the answer;
 *  - a turn of another user's scope teaches nothing; a turn no document
 *    holds becomes a document read with the focus.
 */
import { RelearnFromRawService } from '../src/documents/relearn-from-raw.service';

interface Turn {
  id: string;
  text: string;
  conversationId: string;
  userId?: string | null;
  occurredAt?: string;
}

function harness(
  opts: { turn?: Turn | null; doc?: { id: string } | null; promoted?: number } = {},
) {
  const turn: Turn | null =
    opts.turn === undefined
      ? { id: 'episode:t1', text: 'Созвон в четверг.', conversationId: 'document:d1', userId: null }
      : opts.turn;
  const doc = opts.doc === undefined ? { id: 'source_document:d1' } : opts.doc;
  const calls = {
    enqueued: [] as Array<{ dedupKey: string; payload: Record<string, unknown> }>,
    promoted: [] as unknown[],
    focused: [] as unknown[],
    ingested: [] as unknown[],
    committed: 0,
    scheduled: 0,
  };
  const surreal = {
    withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string) =>
          sql.includes('FROM episode')
            ? [turn ? [{ occurredAt: '2026-09-20T10:00:00Z', ...turn }] : []]
            : [doc ? [{ id: doc.id }] : []],
      }),
  };
  const documents = {
    ingestDocument: async (_c: string, dto: unknown, origin: unknown) => {
      calls.ingested.push({ dto, origin });
      return {};
    },
  };
  const runs = {
    runFocused: async (p: unknown) => {
      calls.focused.push(p);
      return { status: 'succeeded' };
    },
  };
  const commit = {
    commitIfRunsSettled: async () => {
      calls.committed += 1;
      return { committed: true, factIds: ['knowledge_fact:f'] };
    },
  };
  const store = {
    // Looked up by the document's id or its tail (`document:<tail>`).
    getById: async (_c: string, id: string) =>
      doc && (id === doc.id || `source_document:${id}` === doc.id) ? doc : null,
    setStatus: async () => undefined,
  };
  const candidates = {
    promote: async (_c: string, p: unknown) => {
      calls.promoted.push(p);
      return opts.promoted ?? 0;
    },
  };
  const claim = {
    enqueue: async (j: { dedupKey: string; payload: Record<string, unknown> }) => {
      calls.enqueued.push(j);
      return { created: true };
    },
  };
  const batch = {
    schedule: async () => {
      calls.scheduled += 1;
    },
  };
  const svc = new RelearnFromRawService(
    surreal as never,
    documents as never,
    runs as never,
    commit as never,
    store as never,
    candidates as never,
    undefined,
    claim as never,
    batch as never,
  );
  return { svc, calls };
}

const lesson = {
  companyId: 'co',
  episodeIds: ['episode:t1'],
  question: 'Когда созвон?',
  answer: 'В четверг.',
};

describe('RelearnFromRawService', () => {
  it('queues one lesson per cited turn (at most four), keyed by turn and question', async () => {
    const { svc, calls } = harness();
    svc.schedule({
      ...lesson,
      episodeIds: ['episode:1', 'episode:2', 'episode:1', 'episode:3', 'episode:4', 'episode:5'],
      factCited: true,
    });
    await new Promise((r) => setImmediate(r));
    expect(calls.enqueued).toHaveLength(4);
    expect(new Set(calls.enqueued.map((j) => j.dedupKey)).size).toBe(4);
    expect(calls.enqueued[0]!.payload).toMatchObject({
      episodeId: 'episode:1',
      question: 'Когда созвон?',
      factCited: true,
    });
  });

  it('promotes a turn cited before it was understood, and does nothing else', async () => {
    const { svc, calls } = harness({ promoted: 1 });
    expect(await svc.relearn(lesson)).toEqual({ turns: 1, facts: 0 });
    expect(calls.promoted).toEqual([
      expect.objectContaining({ priority: 2, target: { docIds: ['source_document:d1'] } }),
    ]);
    expect(calls.scheduled).toBe(1);
    expect(calls.focused).toEqual([]);
  });

  it('re-reads a read turn with the question as focus, and commits', async () => {
    const { svc, calls } = harness();
    expect(await svc.relearn(lesson)).toEqual({ turns: 1, facts: 1 });
    expect(calls.focused).toEqual([
      expect.objectContaining({
        text: 'Созвон в четверг.',
        focus: { question: 'Когда созвон?', answer: 'В четверг.' },
      }),
    ]);
    expect(calls.committed).toBe(1);
  });

  it('teaches nothing from a read turn when facts carried the answer', async () => {
    const { svc, calls } = harness();
    expect(await svc.relearn({ ...lesson, factCited: true })).toEqual({ turns: 0, facts: 0 });
    expect(calls.focused).toEqual([]);
  });

  it("teaches nothing from another user's turn", async () => {
    const { svc, calls } = harness({
      turn: { id: 'episode:t1', text: 'x', conversationId: 'document:d1', userId: 'u2' },
    });
    expect(await svc.relearn({ ...lesson, userId: 'u1' })).toEqual({ turns: 0, facts: 0 });
    expect(calls.promoted).toEqual([]);
  });

  it('turns a turn no document holds into a document read with the focus', async () => {
    const { svc, calls } = harness({
      turn: { id: 'episode:t9', text: 'Старая реплика.', conversationId: 'chat-1' },
      doc: null,
    });
    expect(await svc.relearn({ ...lesson, episodeIds: ['episode:t9'] })).toEqual({
      turns: 1,
      facts: 0,
    });
    expect(calls.ingested).toHaveLength(1);
    expect(JSON.stringify(calls.ingested[0])).toContain('Когда созвон?');
  });
});
