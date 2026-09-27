/**
 * The batch pass's decisions, with every collaborator stubbed
 * (ExtractionBatchService; read-depth.ts; docs/roadmap/raw-processing-
 * triggers-2026-09.md §4.1–4.2):
 *  - triage: one request per waiting turn, read with the turns before it
 *    as context — skipped for what already carries a stamp;
 *  - a held conversation is read at once when a turn is urgent;
 *  - depth: noise and routine text kept raw (no read); urgent, in-use,
 *    asked-for or untriaged read in full; in-use asked only when the text
 *    would otherwise be kept raw; the idle budget reads the most salient
 *    of the deferred backlog, one sample each;
 *  - a turn kept raw never joins its conversation's group;
 *  - the pass lists what it has not taken yet, and steps back — asking
 *    again later — when another replica holds the tenant.
 */
import { ExtractionBatchService } from '../src/documents/extraction-batch.service';
import type { TriageStamp } from '../src/documents/triage';
import { SALIENCE_LEVELS } from '../src/documents/triage';

const NOW = Date.now();

interface Doc {
  id: string;
  occurredAt: Date;
  chunkCount: number;
  meta: Record<string, unknown>;
  status: string;
  userId?: string;
  triage?: TriageStamp;
}

const turn = (id: string, conv: string, secondsAgo: number, over: Partial<Doc> = {}): Doc => ({
  id: `source_document:${id}`,
  occurredAt: new Date(NOW - secondsAgo * 1000),
  chunkCount: 1,
  meta: { conversationId: conv },
  status: 'indexing',
  ...over,
});
const note = (id: string, over: Partial<Doc> = {}): Doc => ({
  id: `source_document:${id}`,
  occurredAt: new Date(NOW - 60_000),
  chunkCount: 1,
  meta: {},
  status: 'indexing',
  ...over,
});

type Verdict = 'noise' | 'routine' | 'correction';

function answers(v: Verdict) {
  const p = (x: number) => ({ type: 'noul', noul: x });
  const level = v === 'noise' ? 0 : 1;
  return {
    model: 'stub',
    usage: { inputTokens: 0, outputTokens: 0 },
    answers: {
      durable: p(v === 'noise' ? 0.05 : 0.9),
      change: p(v === 'correction' ? 0.9 : 0.05),
      instruction: p(0.05),
      correction: p(v === 'correction' ? 0.95 : 0.05),
      identity: p(0.05),
      state: p(0.05),
      salience: {
        type: 'score',
        score: level,
        confidence: 0.9,
        legend: Object.fromEntries(SALIENCE_LEVELS.map((c, i) => [String(i), c])),
        probabilities: Object.fromEntries(
          SALIENCE_LEVELS.map((_, i) => [String(i), i === level ? 0.9 : 0.03]),
        ),
      },
    },
  };
}

function harness(opts: {
  docs: Doc[];
  texts: Record<string, string>;
  verdict: (text: string) => Verdict;
  priority?: Record<string, number>;
  inUse?: boolean;
  leaseHeld?: boolean;
  triageOff?: boolean;
}) {
  const byId = new Map(opts.docs.map((d) => [d.id, d]));
  const triaged: string[] = [];
  const stamped: Array<{ ids: string[] }> = [];
  const reads: Array<{ ids: string[]; depth?: string | undefined }> = [];
  const keptRaw: string[] = [];
  const promotions: unknown[] = [];
  const listCalls: Array<{ exclude?: string[] | undefined }> = [];
  const scheduled: Array<{ retry?: number; delayMs?: number }> = [];
  const inUseAsked: string[] = [];
  let listed = false;
  const store = {
    getById: async (_c: string, id: string) => byId.get(id) ?? null,
    getChunks: async (_c: string, id: string) => [
      { seq: 0, text: opts.texts[id] ?? 'x', charStart: 0, charEnd: 1 },
    ],
    setStatus: async () => undefined,
    setTriage: async (_c: string, ids: string[]) => {
      stamped.push({ ids });
    },
  };
  const candidates = {
    listAwaitingRuns: async (_c: string, p: { exclude?: string[] }) => {
      listCalls.push({ exclude: p.exclude });
      if (listed) return [];
      listed = true;
      return opts.docs.map((d) => ({
        docId: d.id,
        arrivedAt: d.occurredAt,
        priority: opts.priority?.[d.id] ?? 0,
      }));
    },
    promote: async (_c: string, p: unknown) => {
      promotions.push(p);
      return 1;
    },
  };
  const runs = {
    runGeneral: async (p: { doc: { id: string }; depth?: string }) => {
      reads.push({ ids: [p.doc.id], depth: p.depth });
      return { status: 'succeeded' };
    },
    runGeneralGroup: async (p: { docs: Array<{ id: string }>; depth?: string }) => {
      reads.push({ ids: p.docs.map((d) => d.id), depth: p.depth });
      return [];
    },
    keepRaw: async (p: { doc: { id: string } }) => {
      keptRaw.push(p.doc.id);
      return { status: 'skipped' };
    },
  };
  const commit = {
    commitIfRunsSettled: async () => ({
      committed: true,
      deferred: false,
      entityIds: [],
      factIds: [],
      edgeIds: [],
    }),
  };
  const claim = {
    enqueue: async (j: { payload: { retry: number }; visibleAfter: Date }) => {
      scheduled.push({
        retry: j.payload.retry,
        delayMs: j.visibleAfter.getTime() - Date.now(),
      });
      return { created: true };
    },
  };
  const memory = {
    inUse: async (p: { text: string }) => {
      inUseAsked.push(p.text);
      return opts.inUse === true;
    },
    remember: () => undefined,
  };
  const decisions = {
    enabled: (lane: string) => lane === 'triage' && !opts.triageOff,
    decide: async (_lane: string, req: { state: string | string[] }) => {
      // The judged text is the last part; the turns before it ride as context.
      const parts = Array.isArray(req.state) ? req.state : [req.state];
      triaged.push(parts.join('\n'));
      return answers(opts.verdict(parts.at(-1) ?? ''));
    },
  };
  const lease = {
    tryAcquire: async () => !opts.leaseHeld,
    release: async () => undefined,
  };
  const svc = new ExtractionBatchService(
    store as never,
    candidates as never,
    runs as never,
    commit as never,
    undefined,
    claim as never,
    memory as never,
    decisions as never,
    undefined,
    lease as never,
  );
  return {
    svc,
    triaged,
    stamped,
    reads,
    keptRaw,
    promotions,
    listCalls,
    scheduled,
    inUseAsked,
  };
}

const verdictOf = (text: string): Verdict =>
  /Нет,/.test(text) ? 'correction' : /спасибо/.test(text) ? 'noise' : 'routine';

describe('ExtractionBatchService — triage, urgency, depth', () => {
  it('triages each turn, with the turns before it as context, and a note alone', async () => {
    const h = harness({
      docs: [turn('a', 'c1', 300), turn('b', 'c1', 200), note('n')],
      texts: {
        'source_document:a': 'Бюджет Orbis — 3000.',
        'source_document:b': 'Созвон в четверг.',
        'source_document:n': 'Офис переехал.',
      },
      verdict: verdictOf,
    });
    await h.svc.runPass('co', { force: true });
    expect(h.triaged).toHaveLength(3);
    const second = h.triaged.find((t) => t.includes('TEXT:\nСозвон в четверг.'))!;
    // The earlier turn is context, not what is judged.
    expect(second).toContain('CONTEXT');
    expect(second).toContain('Бюджет Orbis — 3000.');
    expect(h.stamped.map((s) => s.ids.length)).toEqual([1, 1, 1]);
  });

  it('does not triage what already carries a stamp', async () => {
    const stamp = {
      v: 2,
      at: 'x',
      durable: 0.9,
      change: 0.1,
      instruction: 0.1,
      correction: 0.1,
      identity: 0.1,
      state: 0.1,
      salience: 1,
    };
    const h = harness({
      docs: [note('n', { triage: stamp })],
      texts: {},
      verdict: verdictOf,
    });
    await h.svc.runPass('co', { force: true });
    expect(h.triaged).toHaveLength(0);
    expect(h.keptRaw).toEqual(['source_document:n']);
  });

  it('keeps noise and routine text raw — no read', async () => {
    const h = harness({
      docs: [note('noise'), note('fact')],
      texts: { 'source_document:noise': 'Ок, спасибо!', 'source_document:fact': 'Офис переехал.' },
      verdict: verdictOf,
    });
    await h.svc.runPass('co', { force: true });
    expect(h.keptRaw.sort()).toEqual(['source_document:fact', 'source_document:noise']);
    expect(h.reads).toEqual([]);
  });

  it('reads in full what names an entity in use — asking only when it would be shallow', async () => {
    const h = harness({
      docs: [note('noise'), turn('x', 'cx', 5)],
      texts: {
        'source_document:noise': 'Ок, спасибо!',
        'source_document:x': 'Нет, бюджет теперь 2500.',
      },
      verdict: verdictOf,
      inUse: true,
    });
    await h.svc.runPass('co', { force: true });
    expect(h.keptRaw).toEqual([]);
    expect(h.reads).toContainEqual({ ids: ['source_document:noise'], depth: 'full' });
    // The correction is full on its own: in-use was not asked about it.
    expect(h.inUseAsked).toEqual(['Ок, спасибо!']);
  });

  it('reads in full what is untriaged (the lane off)', async () => {
    const h = harness({
      docs: [note('n')],
      texts: { 'source_document:n': 'Ок, спасибо!' },
      verdict: verdictOf,
      triageOff: true,
    });
    await h.svc.runPass('co', { force: true });
    expect(h.reads).toEqual([{ ids: ['source_document:n'], depth: 'full' }]);
  });

  it('reads in full, and at once, what something asked for', async () => {
    const h = harness({
      docs: [turn('t', 'cp', 1)],
      texts: { 'source_document:t': 'Ок, спасибо!' },
      verdict: verdictOf,
      priority: { 'source_document:t': 2 },
    });
    // Not forced, the conversation still talking: promoted → read now.
    await h.svc.runPass('co');
    expect(h.reads).toEqual([{ ids: ['source_document:t'], depth: 'full' }]);
  });

  it('holds a talking conversation — unless a turn is urgent; then reads only the turns worth reading', async () => {
    const calm = harness({
      docs: [turn('a', 'c2', 10), turn('b', 'c2', 5)],
      texts: { 'source_document:a': 'Бюджет — 3000.', 'source_document:b': 'Созвон в четверг.' },
      verdict: verdictOf,
    });
    await calm.svc.runPass('co');
    expect(calm.reads).toEqual([]);
    // Asked again when it goes quiet.
    expect(calm.scheduled.some((s) => (s.delayMs ?? 0) > 60_000)).toBe(true);

    const urgent = harness({
      docs: [turn('a', 'c3', 10), turn('b', 'c3', 5)],
      texts: {
        'source_document:a': 'Ок, спасибо!',
        'source_document:b': 'Нет, бюджет теперь 2500.',
      },
      verdict: verdictOf,
    });
    await urgent.svc.runPass('co');
    expect(urgent.reads).toEqual([{ ids: ['source_document:b'], depth: 'full' }]);
    expect(urgent.keptRaw).toEqual(['source_document:a']);
    expect(urgent.promotions).toEqual([]);
  });

  it('lists only what it has not taken yet', async () => {
    const h = harness({
      docs: [note('n')],
      texts: {},
      verdict: verdictOf,
    });
    await h.svc.runPass('co', { force: true });
    expect(h.listCalls.map((c) => c.exclude)).toEqual([[], ['source_document:n']]);
  });

  it('steps back when another replica holds the tenant, and asks again after the lease', async () => {
    const h = harness({ docs: [note('n')], texts: {}, verdict: verdictOf, leaseHeld: true });
    expect(await h.svc.runPass('co')).toEqual({ read: 0, failed: 0, committed: 0, retry: 0 });
    expect(h.reads).toEqual([]);
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]!.delayMs).toBeGreaterThanOrEqual(110_000);
  });

  it('the idle budget reopens the most salient deferred reads and asks for a pass; 0 reads on demand only', async () => {
    const listed: unknown[] = [];
    const h = harness({ docs: [], texts: {}, verdict: verdictOf });
    const candidates = (h.svc as unknown as { candidates: Record<string, unknown> }).candidates;
    candidates.listDeferred = async (_c: string, p: unknown) => {
      listed.push(p);
      return ['source_document:d1', 'source_document:d2'];
    };
    expect(await h.svc.readDeferred('co')).toBe(1);
    expect(listed).toEqual([expect.objectContaining({ limit: 64, floor: 0.5 })]);
    expect(h.promotions).toEqual([
      expect.objectContaining({
        priority: 1,
        target: { docIds: ['source_document:d1', 'source_document:d2'] },
      }),
    ]);
    expect(h.scheduled).toHaveLength(1);
    process.env.EXTRACTION_IDLE_BUDGET_DOCS = '0';
    try {
      expect(await h.svc.readDeferred('co')).toBe(0);
      expect(listed).toHaveLength(1);
    } finally {
      delete process.env.EXTRACTION_IDLE_BUDGET_DOCS;
    }
  });

  it('an idle-reopened read is read with one sample', async () => {
    const h = harness({
      docs: [note('n')],
      texts: { 'source_document:n': 'Офис переехал.' },
      verdict: verdictOf,
      priority: { 'source_document:n': 1 },
    });
    await h.svc.runPass('co', { force: true });
    expect(h.reads).toEqual([{ ids: ['source_document:n'], depth: 'single' }]);
  });
});
