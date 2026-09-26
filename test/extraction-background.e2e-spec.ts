/**
 * Extraction off the write path (extraction-batch.service.ts).
 *
 * A turn is remembered when it arrives — stored, its raw turn captured —
 * and the write answers at once. The batch pass reads every waiting turn
 * of a conversation in ONE extraction call and files each claim under the
 * turn its clause was copied from. A provider outage fails the pass, not
 * the memory: the turns stay, and the retry pass reads them.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { ExtractionBatchService } from '../src/documents/extraction-batch.service';
import type { ConversationContext } from '../src/ai/extractor.service';
import { PENDING_MARK } from '../src/synthesize/pending-mark';
import { mockSynthesizeOpenAi } from './test-doubles';

describe('background extraction (e2e)', () => {
  let f: AppFixture;
  let batch: ExtractionBatchService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    // No worker runs the queued jobs: the pass runs when the spec calls
    // it, so what one call read is deterministic.
    process.env.WORKER_LOOP_ENABLED = '0';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    f = await createApp({ backgroundExtraction: true });
    batch = f.app.get(ExtractionBatchService);
  });

  afterAll(async () => {
    delete process.env.WORKER_LOOP_ENABLED;
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.INGEST_MENTION_VIA_DOCUMENT;
    await f.close();
  });

  afterEach(() => {
    f.extractor.setScript(null);
    f.extractor.setFailure(null);
  });

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
          vertical: 'xbatch_e2e',
          conversationId,
          messageId: `${conversationId}-${at}`,
        },
      });

  const TURNS = [
    'Бюджет пилота Acme — 4000 евро.',
    'Созвон с Acme перенесли на четверг.',
    'Нет, бюджет Acme теперь 2500 евро.',
  ];

  const script = () =>
    f.extractor.setScript({
      entities: [{ name: 'Acme', type: 'customer' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'budget',
          object: '4000 евро',
          confidence: 0.9,
          clause: TURNS[0],
        },
        {
          entityIndex: 0,
          predicate: 'meeting',
          object: 'четверг',
          confidence: 0.9,
          clause: TURNS[1],
        },
        {
          entityIndex: 0,
          predicate: 'budget',
          object: '2500 евро',
          confidence: 0.9,
          clause: TURNS[2],
        },
      ],
      edges: [],
    });

  const candidatesByDoc = async (docIds: string[]) => {
    const rows = await query<{ docId: unknown; predicate?: string }>(
      `SELECT docId, payload.predicate AS predicate FROM candidate WHERE kind = 'fact'`,
    );
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const k = String(r.docId);
      if (!docIds.includes(k)) continue;
      out.set(k, [...(out.get(k) ?? []), String(r.predicate)]);
    }
    return out;
  };

  const docsOf = async (conversationId: string) =>
    (
      await query<{ id: unknown; status: string; occurredAt: unknown }>(
        `SELECT id, status, occurredAt FROM source_document
           WHERE meta.conversationId = $c ORDER BY occurredAt ASC`,
        { c: conversationId },
      )
    ).map((d) => ({ id: String(d.id), status: d.status }));

  it('answers at once with the turn remembered, and reads a conversation in one call', async () => {
    const conv = 'xb-conv-1';
    const calls = f.extractor.contexts.length;
    for (const [i, text] of TURNS.entries()) {
      const r = await say(conv, text, `2026-09-2${i + 1}T10:00:00.000Z`);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ skipped: false, pending: true });
    }
    // Remembered before understood: the raw turns are there, no read ran.
    const episodes = await query<{ text: string }>(
      `SELECT text FROM episode WHERE conversationId = $c AND kind = 'turn'`,
      { c: conv },
    );
    expect(episodes.map((e) => e.text).sort()).toEqual([...TURNS].sort());
    expect(f.extractor.contexts.length).toBe(calls);

    script();
    // Still talking (its last turn arrived a moment ago): held, read later.
    expect(await batch.runPass(f.companyId)).toMatchObject({ read: 0, failed: 0 });
    expect(f.extractor.contexts.length).toBe(calls);
    // Quiet now: the three turns are read together.
    process.env.EXTRACTION_CONVERSATION_SETTLE_SECONDS = '0';
    const pass = await batch.runPass(f.companyId);
    delete process.env.EXTRACTION_CONVERSATION_SETTLE_SECONDS;
    expect(pass).toMatchObject({ read: 3, failed: 0, committed: 3 });

    // ONE extraction call read the three turns, each under its header.
    expect(f.extractor.contexts.length).toBe(calls + 1);
    const ctx = f.extractor.contexts[calls] as ConversationContext;
    expect(ctx.turns?.map((t) => t.label)).toEqual(['#1', '#2', '#3']);

    // Each claim is filed under the turn its clause was copied from.
    const docs = await docsOf(conv);
    expect(docs.map((d) => d.status)).toEqual(['committed', 'committed', 'committed']);
    const byDoc = await candidatesByDoc(docs.map((d) => d.id));
    expect(byDoc.get(docs[0]!.id)).toEqual(['budget']);
    expect(byDoc.get(docs[1]!.id)).toEqual(['meeting']);
    expect(byDoc.get(docs[2]!.id)).toEqual(['budget']);
  });

  it('a provider outage leaves the turns remembered; the retry pass reads them', async () => {
    const conv = 'xb-conv-2';
    // New words: a replayed turn is deduplicated, not read again.
    await say(conv, 'Acme подписали NDA.', '2026-09-24T10:00:00.000Z');
    await say(conv, 'Юрист Acme — Марта.', '2026-09-24T10:01:00.000Z');

    f.extractor.setFailure(new Error('429 credit_balance_exhausted'));
    const failed = await batch.runPass(f.companyId, { force: true });
    expect(failed).toMatchObject({ read: 0, failed: 2, committed: 0 });
    expect((await docsOf(conv)).every((d) => d.status !== 'committed')).toBe(true);

    // A plain pass does not hammer what just failed …
    f.extractor.setFailure(null);
    f.extractor.setScript({
      entities: [
        { name: 'Acme', type: 'customer' },
        { name: 'Марта', type: 'staff' },
      ],
      facts: [
        {
          entityIndex: 0,
          predicate: 'signed',
          object: 'NDA',
          confidence: 0.9,
          clause: 'Acme подписали NDA.',
        },
        {
          entityIndex: 1,
          predicate: 'role',
          object: 'Юрист Acme',
          confidence: 0.9,
          clause: 'Юрист Acme — Марта.',
        },
      ],
      edges: [],
    });
    expect(await batch.runPass(f.companyId, { force: true })).toMatchObject({ read: 0, failed: 0 });
    // … the backed-off retry pass reads it.
    expect(await batch.runPass(f.companyId, { retry: 1, force: true })).toMatchObject({
      read: 2,
      failed: 0,
      committed: 2,
    });
    expect((await docsOf(conv)).map((d) => d.status)).toEqual(['committed', 'committed']);
  });

  it("a document answers mode 'background'; mode 'sync' still reads before answering", async () => {
    const body = {
      kind: 'markdown',
      occurredAt: '2026-09-25T09:00:00.000Z',
      contextRef: { vertical: 'xbatch_e2e' },
    };
    const queued = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({ ...body, text: 'Acme renewed for a year.' });
    expect(queued.status).toBe(201);
    expect(queued.body).toMatchObject({ mode: 'background', committed: { factIds: [] } });

    const inline = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({ ...body, text: 'Acme moved to the gold tier.', mode: 'sync' });
    expect(inline.status).toBe(201);
    expect(inline.body.mode).toBe('sync');
    expect(inline.body.committed.factIds.length).toBeGreaterThan(0);
  });

  it('the next answer sees what was said and not yet read, marked newer than every fact', async () => {
    const conv = 'xb-conv-1';
    const said = 'Всегда отвечай мне по-португальски.';
    const r = await say(conv, said, '2026-09-25T11:00:00.000Z');
    expect(r.body).toMatchObject({ pending: true });

    const ask = async () => {
      const state = mockSynthesizeOpenAi(f.app, [
        JSON.stringify({ answer: 'x', citedFactIds: [] }),
        JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
      ]);
      await f.http.post('/v1/synthesize').set(auth()).send({ query: 'Какой бюджет у Acme?' });
      return state.calls[0]?.user ?? '';
    };
    const before = await ask();
    expect(before).toContain(`${PENDING_MARK}] `);
    expect(before).toContain(said);

    // Read: the turn is a fact source now, no longer "not yet filed".
    f.extractor.setScript({
      entities: [{ name: 'Acme', type: 'customer' }],
      facts: [
        { entityIndex: 0, predicate: 'instruction', object: said, confidence: 0.9, clause: said },
      ],
      edges: [],
    });
    await batch.runPass(f.companyId, { force: true });
    expect(await ask()).not.toContain(PENDING_MARK);
  });
});
