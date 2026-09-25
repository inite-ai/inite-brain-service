/**
 * A document posted directly becomes raw turns the read lanes can reach.
 *
 * Dogfooding production over MCP: a document answered a question verbatim
 * ("до 24 сентября движок работал на gpt-5.6-luna") and synthesize could
 * not say it — the facts had lost the date, and every lane that reads
 * the raw text (excerpts, raw windows, grounding quotes, the episodic
 * lane, L3 sessions) found nothing, because a document captured no L0
 * turns and its facts named none. This pins the capture: the chunks are
 * cut into speaker turns under `document:<id>`, each fact points at the
 * turn its value sits in, a re-commit adds nothing, and a document
 * stored without its content keeps no raw text either.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { StringRecordId } from 'surrealdb';

describe('document raw turns (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const CHAT =
    'Михаил: дроплет brain сейчас 2 vCPU, с 1 октября переезжаем на 4 vCPU.\n' +
    'Claude: Понял. До переезда держу локальный bge-m3 запасным.\n' +
    'Михаил: и бюджет OpenRouter на октябрь 40 долларов.';

  beforeAll(async () => {
    f = await createApp();
    process.env.DOCUMENT_INGEST_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    await f.close();
  });

  afterEach(() => {
    f.extractor.setScript(null);
  });

  const script = () =>
    f.extractor.setScript({
      entities: [
        { name: 'дроплет brain', type: 'asset' },
        { name: 'OpenRouter', type: 'other' },
      ],
      facts: [
        { entityIndex: 0, predicate: 'cpu', object: '2 vCPU', confidence: 0.9 },
        { entityIndex: 1, predicate: 'budget', object: '40 долларов', confidence: 0.9 },
      ],
      edges: [],
    });

  const post = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'chat',
        title: 'Инфраструктура',
        occurredAt: '2026-09-24T21:40:00.000Z',
        contextRef: { vertical: 'raw_turns_e2e' },
        ...body,
      });

  const query = <T>(sql: string, vars: Record<string, unknown>) =>
    f.app
      .get(SurrealService)
      .withCompany(f.companyId, async (db) => (await db.query<[T[]]>(sql, vars))[0] ?? []);

  it('stores the speaker turns and points each fact at the turn its value sits in', async () => {
    script();
    const r = await post({ text: CHAT });
    expect(r.status).toBe(201);
    const conv = `document:${String(r.body.documentId).replace(/^source_document:/, '')}`;

    const turns = await query<{ id: unknown; speaker: string; text: string }>(
      'SELECT id, speaker, text, occurredAt FROM episode WHERE conversationId = $conv ORDER BY occurredAt',
      { conv },
    );
    expect(turns.map((t) => t.speaker)).toEqual(['Михаил', 'Claude', 'Михаил']);

    const facts = await query<{ object: string; eps?: unknown[] }>(
      'SELECT object, source.episodeIds AS eps FROM knowledge_fact WHERE id INSIDE $ids',
      { ids: (r.body.committed.factIds as string[]).map((id) => new StringRecordId(id)) },
    );
    const turnOf = (object: string) => {
      const ep = String(facts.find((x) => x.object === object)?.eps?.[0]);
      return turns.find((t) => String(t.id) === ep)?.text;
    };
    expect(turnOf('2 vCPU')).toContain('сейчас 2 vCPU');
    expect(turnOf('40 долларов')).toContain('бюджет OpenRouter');

    // The episodes API lists them as one conversation, like any chat's.
    const listed = await f.http
      .get(`/v1/episodes?conversationId=${encodeURIComponent(conv)}`)
      .set(auth());
    expect(listed.status).toBe(200);
    expect(listed.body.episodes).toHaveLength(3);
  });

  it('a document stored without its content keeps no raw turns', async () => {
    script();
    const r = await post({ text: `${CHAT}\nClaude: принято.`, storeContent: false });
    expect(r.status).toBe(201);
    const conv = `document:${String(r.body.documentId).replace(/^source_document:/, '')}`;
    const turns = await query('SELECT id FROM episode WHERE conversationId = $conv', { conv });
    expect(turns).toHaveLength(0);
  });
});
