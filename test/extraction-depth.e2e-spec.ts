/**
 * How deep captured text is read, and what makes it read sooner or deeper
 * (read-depth.ts, extraction-batch.service.ts, relearn-from-raw.service.ts;
 * docs/roadmap/raw-processing-triggers-2026-09.md §4.1–4.2).
 *
 * The D1 triage is stubbed per text: small talk is noise on every
 * question, a routine note is durable, a correction is urgent.
 *  - noise is kept raw: no extraction, the run closed `skipped` at depth
 *    raw, the turn still remembered;
 *  - a routine text is read with one sample, an urgent one in full;
 *  - an urgent turn reads its conversation at once, not when it goes quiet;
 *  - it reopens the turns of its conversation kept raw (retroactive capture);
 *  - an answer that cites a raw-kept turn gets it read, ahead of the backlog.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { ExtractionBatchService } from '../src/documents/extraction-batch.service';
import { RelearnFromRawService } from '../src/documents/relearn-from-raw.service';
import { DecisionService } from '../src/ai/decisions/decision.service';
import { SALIENCE_LEVELS } from '../src/documents/triage';

function triageOf(text: string) {
  const noise = /спасибо|^\S*:?\s*ок\b|окей/i.test(text) && !/бюджет|нет,/i.test(text);
  const correction = /нет, /i.test(text);
  const p = (v: number) => ({ type: 'noul' as const, noul: v });
  const level = noise ? 0 : 1;
  return {
    model: 'stub',
    usage: { inputTokens: 0, outputTokens: 0 },
    answers: {
      durable: p(noise ? 0.05 : 0.9),
      change: p(correction ? 0.9 : 0.05),
      instruction: p(0.05),
      correction: p(correction ? 0.95 : 0.05),
      identity: p(0.05),
      salience: {
        type: 'score' as const,
        score: level,
        confidence: 0.9,
        legend: Object.fromEntries(SALIENCE_LEVELS.map((c, i) => [String(i), c])),
        probabilities: Object.fromEntries(
          SALIENCE_LEVELS.map((_, i) => [String(i), i === level ? 0.9 : 0.1 / 3]),
        ),
      },
    },
  };
}

describe('read depth and promotion (e2e)', () => {
  let f: AppFixture;
  let batch: ExtractionBatchService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    process.env.WORKER_LOOP_ENABLED = '0';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    f = await createApp({ backgroundExtraction: true });
    batch = f.app.get(ExtractionBatchService);
    const decisions = f.app.get(DecisionService);
    jest.spyOn(decisions, 'enabled').mockImplementation((lane) => lane === 'triage');
    jest
      .spyOn(decisions, 'decide')
      .mockImplementation(async (_lane, req) => triageOf(String(req.state)) as never);
  });

  afterAll(async () => {
    delete process.env.WORKER_LOOP_ENABLED;
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.INGEST_MENTION_VIA_DOCUMENT;
    await f.close();
  });

  afterEach(() => f.extractor.setScript(null));

  const query = <T>(sql: string, vars: Record<string, unknown> = {}) =>
    f.app
      .get(SurrealService)
      .withCompany(f.companyId, async (db) => (await db.query<[T[]]>(sql, vars))[0] ?? []);

  const say = (conversationId: string, text: string, at: string) =>
    f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        emittedAt: at,
        contextRef: {
          vertical: 'xdepth_e2e',
          conversationId,
          messageId: `${conversationId}-${at}`,
        },
      });

  const runsOf = (conversationId: string) =>
    query<{ status: string; depth?: string; priority?: number; text: string }>(
      `SELECT status, stats.depth AS depth, priority, docId.occurredAt AS at FROM indexer_run
         WHERE packId = '_general' AND docId.meta.conversationId = $c ORDER BY at ASC`,
      { c: conversationId },
    );

  it('keeps small talk raw: no extraction, a skipped run at depth raw, the turn remembered', async () => {
    const conv = 'xd-noise';
    const calls = f.extractor.contexts.length;
    await say(conv, 'Ок, спасибо!', '2026-09-20T10:00:00.000Z');
    const pass = await batch.runPass(f.companyId, { force: true });
    expect(pass).toMatchObject({ read: 0, failed: 0 });
    expect(f.extractor.contexts.length).toBe(calls);
    expect(await runsOf(conv)).toMatchObject([{ status: 'skipped', depth: 'raw' }]);
    const turns = await query<{ text: string }>(
      `SELECT text FROM episode WHERE conversationId = $c AND kind = 'turn'`,
      { c: conv },
    );
    expect(turns.map((t) => t.text)).toEqual(['Ок, спасибо!']);
  });

  it('reads a routine note with one sample', async () => {
    const passes = f.extractor.passes.length;
    await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        text: 'Офис Orbis переехал на третий этаж.',
        occurredAt: '2026-09-20T11:00:00.000Z',
        contextRef: { vertical: 'xdepth_e2e' },
      });
    await batch.runPass(f.companyId, { force: true });
    expect(f.extractor.passes.slice(passes)).toEqual([1]);
  });

  it('an urgent turn reads its conversation at once, and reopens its raw-kept turns', async () => {
    const conv = 'xd-correct';
    await say(conv, 'Ок, спасибо!!', '2026-09-21T10:00:00.000Z');
    await batch.runPass(f.companyId, { force: true });
    expect(await runsOf(conv)).toMatchObject([{ status: 'skipped', depth: 'raw' }]);

    // Still talking (no settle override, no force) — but a correction.
    const passes = f.extractor.passes.length;
    await say(conv, 'Нет, бюджет Orbis теперь 2500 евро.', '2026-09-21T10:01:00.000Z');
    const pass = await batch.runPass(f.companyId);
    // The correction, read at once in full — and its raw-kept neighbour,
    // reopened beside it (priority 1) and read in full by the same pass.
    expect(pass.read).toBe(2);
    expect(f.extractor.passes.slice(passes)).toEqual([undefined, undefined]);
    expect(await runsOf(conv)).toMatchObject([
      { status: 'succeeded', depth: 'full', priority: 1 },
      { status: 'succeeded', depth: 'full' },
    ]);
  });

  it('an answer citing a raw-kept turn gets it read, ahead of the backlog', async () => {
    const conv = 'xd-cited';
    await say(conv, 'Окей, спасибо, до связи', '2026-09-22T10:00:00.000Z');
    await batch.runPass(f.companyId, { force: true });
    expect(await runsOf(conv)).toMatchObject([{ status: 'skipped', depth: 'raw' }]);
    const [turn] = await query<{ id: unknown }>(
      `SELECT id FROM episode WHERE conversationId = $c AND kind = 'turn'`,
      { c: conv },
    );
    await f.app.get(RelearnFromRawService).relearn({
      companyId: f.companyId,
      episodeIds: [String(turn!.id)],
      question: 'Когда созвон?',
      answer: 'До связи.',
      factCited: false,
    });
    expect(await runsOf(conv)).toMatchObject([{ status: 'pending', priority: 2 }]);
    const passes = f.extractor.passes.length;
    await batch.runPass(f.companyId, { force: true });
    expect(await runsOf(conv)).toMatchObject([{ status: 'succeeded', depth: 'full' }]);
    expect(f.extractor.passes.slice(passes)).toEqual([undefined]);
  });

  it('a waiting generalist read is never reaped as stale', async () => {
    await say('xd-wait', 'Бюджет Nova — 900 евро.', '2026-09-23T10:00:00.000Z');
    process.env.INDEXER_RUN_STALE_MINUTES = '0.00001';
    try {
      await new Promise((r) => setTimeout(r, 20));
      const { CandidateStoreService } = await import('../src/documents/candidate-store.service');
      await f.app.get(CandidateStoreService).reapStaleRuns(f.companyId);
    } finally {
      delete process.env.INDEXER_RUN_STALE_MINUTES;
    }
    expect(await runsOf('xd-wait')).toMatchObject([{ status: 'pending' }]);
  });
});
