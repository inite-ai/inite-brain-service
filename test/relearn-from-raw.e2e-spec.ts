/**
 * Memory learns from an answer it had to read raw.
 *
 * A document's turn held a reason its extraction missed; the facts could
 * not answer "why", the raw turn could (L3). RelearnFromRawService reads
 * that turn again with the question as the extractor's focus. Pins:
 *  - the extractor is told the question and the answer it must not miss;
 *  - the new fact is committed and walks back to the SAME raw turn
 *    (source.episodeIds) — nothing is captured twice;
 *  - a turn from one user's memory never teaches another scope.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { RelearnFromRawService } from '../src/documents/relearn-from-raw.service';

describe('relearn from raw (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const TEXT =
    'Михаил: fs на проде выключен.\n' +
    'Claude: Да, намеренно: на дроплете нет папок для чтения, папки машины читает локальный агент.';

  beforeAll(async () => {
    f = await createApp();
    process.env.DOCUMENT_INGEST_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    await f.close();
  });

  afterEach(() => f.extractor.setScript(null));

  const query = <T>(sql: string, vars: Record<string, unknown>) =>
    f.app
      .get(SurrealService)
      .withCompany(f.companyId, async (db) => (await db.query<[T[]]>(sql, vars))[0] ?? []);

  it('reads the cited turn again with the question as focus, and the fact walks back to it', async () => {
    // First reading: the extraction keeps the state and misses the reason.
    f.extractor.setScript({
      entities: [{ name: 'fs', type: 'other' }],
      facts: [
        { entityIndex: 0, predicate: 'enabled_in_production', object: 'выключен', confidence: 0.9 },
      ],
      edges: [],
    });
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'chat',
        text: TEXT,
        occurredAt: '2026-09-24T17:00:00.000Z',
        contextRef: { vertical: 'relearn_e2e' },
      });
    expect(r.status).toBe(201);
    const conv = `document:${String(r.body.documentId).replace(/^source_document:/, '')}`;
    const turns = await query<{ id: unknown; text: string }>(
      'SELECT id, text, occurredAt FROM episode WHERE conversationId = $conv ORDER BY occurredAt',
      { conv },
    );
    const reasonTurn = turns.find((t) => t.text.includes('нет папок'))!;
    expect(reasonTurn).toBeDefined();

    // The lesson: the answer L3 read from that turn.
    f.extractor.setScript({
      entities: [{ name: 'fs', type: 'other' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'disabled_reason',
          object: 'на дроплете нет папок для чтения',
          confidence: 0.9,
        },
      ],
      edges: [],
    });
    f.extractor.contexts.length = 0;
    const out = await f.app.get(RelearnFromRawService).relearn({
      companyId: f.companyId,
      episodeIds: [String(reasonTurn.id)],
      question: 'Почему fs выключен на проде?',
      answer: 'На дроплете нет папок для чтения.',
    });
    expect(out).toMatchObject({ turns: 1 });
    expect(out.facts).toBeGreaterThanOrEqual(1);

    const told = JSON.stringify(f.extractor.contexts);
    expect(told).toContain('Почему fs выключен на проде?');
    expect(told).toContain('На дроплете нет папок для чтения.');

    const facts = await query<{ eps?: unknown[] }>(
      `SELECT source.episodeIds AS eps FROM knowledge_fact WHERE predicate = 'disabled_reason'`,
      {},
    );
    expect(facts.map((x) => String(x.eps?.[0]))).toContain(String(reasonTurn.id));
    // Nothing captured twice: the conversation still holds its two turns.
    const again = await query('SELECT id FROM episode WHERE conversationId = $conv', { conv });
    expect(again).toHaveLength(2);
  });

  it("never teaches another scope from a user's turn", async () => {
    const [ep] = await query<{ id: unknown }>(
      `CREATE episode CONTENT {
         kind: 'turn', conversationId: 'c_private', messageId: 'm1', speaker: 'Ana',
         text: 'Ana: мой бюджет 40 долларов', occurredAt: time::now(), userId: 'u_ana',
         source: { vertical: 'relearn_e2e' }, scope: []
       }`,
      {},
    );
    f.extractor.contexts.length = 0;
    const out = await f.app.get(RelearnFromRawService).relearn({
      companyId: f.companyId,
      userId: 'u_other',
      episodeIds: [String(ep!.id)],
      question: 'Какой бюджет?',
      answer: '40 долларов',
    });
    expect(out.facts).toBe(0);
    expect(f.extractor.contexts).toHaveLength(0);
  });

  it('teaches a conversation turn too — the turn that IS its document is read again', async () => {
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    try {
      f.extractor.setScript({
        entities: [{ name: 'Acme', type: 'customer' }],
        facts: [{ entityIndex: 0, predicate: 'tier', object: 'gold', confidence: 0.9 }],
        edges: [],
      });
      const said = 'Acme перешли на gold, потому что им нужен SSO.';
      const r = await f.http
        .post('/v1/ingest/mention')
        .set(auth())
        .send({
          text: said,
          emittedAt: '2026-09-24T18:00:00.000Z',
          contextRef: { vertical: 'relearn_e2e', conversationId: 'c_relearn', messageId: 'm_1' },
        });
      expect(r.status).toBe(201);
      const [turn] = await query<{ id: unknown }>(
        `SELECT id FROM episode WHERE conversationId = 'c_relearn'`,
        {},
      );

      f.extractor.setScript({
        entities: [{ name: 'Acme', type: 'customer' }],
        facts: [
          { entityIndex: 0, predicate: 'upgrade_reason', object: 'им нужен SSO', confidence: 0.9 },
        ],
        edges: [],
      });
      f.extractor.contexts.length = 0;
      const lesson = {
        companyId: f.companyId,
        episodeIds: [String(turn!.id)],
        question: 'Почему Acme перешли на gold?',
        answer: 'Им нужен SSO.',
      };
      const out = await f.app.get(RelearnFromRawService).relearn(lesson);
      expect(out).toMatchObject({ turns: 1 });
      expect(out.facts).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(f.extractor.contexts)).toContain('Почему Acme перешли на gold?');
      // The lesson is its own run of the turn's document; taught once.
      const runs = await query<{ packId: string }>(
        `SELECT packId FROM indexer_run WHERE packId = '_relearn'`,
        {},
      );
      expect(runs.length).toBeGreaterThanOrEqual(1);
      f.extractor.contexts.length = 0;
      expect(await f.app.get(RelearnFromRawService).relearn(lesson)).toMatchObject({ facts: 0 });
      expect(f.extractor.contexts).toHaveLength(0);
    } finally {
      delete process.env.INGEST_MENTION_VIA_DOCUMENT;
    }
  });
});
