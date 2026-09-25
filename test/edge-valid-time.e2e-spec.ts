/**
 * A relation holds for a period, end to end (0164), against a real
 * SurrealDB.
 *
 * Production dogfood: "до 24 сентября движок brain работал на
 * gpt-5.6-luna; с 24 сентября — на gpt-6-luna" was written as two
 * timeless edges, and "на какой модели работал движок 22 сентября?"
 * answered gpt-6-luna. This pins the whole path: the extractor's edge
 * eventTime/endTime land on the knowledge_edge row as validFrom /
 * validUntil, the search at asOf walks the relation that held then (the
 * relation leg brings an entity that has no fact at T), and the current
 * read walks today's.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('edge valid time (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
    process.env.DOCUMENT_INGEST_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    await f.close();
  });

  afterEach(() => f.extractor.setScript(null));

  const edgesOf = () =>
    f.app.get(SurrealService).withCompany(
      f.companyId,
      async (db) =>
        (
          await db.query<[Array<{ to: string; validFrom?: unknown; validUntil?: unknown }>]>(
            `SELECT out.canonicalName AS to, validFrom, validUntil FROM knowledge_edge
                WHERE kind = 'runs_on' ORDER BY to`,
          )
        )[0] ?? [],
    );

  const relationsAt = async (asOf?: string) => {
    const r = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'на какой модели работает движок brain', ...(asOf ? { asOf } : {}) });
    expect(r.status).toBe(201);
    const hits = r.body.results as Array<{
      canonicalName: string;
      facts: Array<{ factId: string; predicate: string; object: string }>;
      relations?: Array<{ kind: string; peer: string }>;
    }>;
    const brain = hits.find((h) => h.canonicalName === 'brain');
    return [
      ...(brain?.facts ?? []).filter((x) => x.predicate === 'runs_on').map((x) => x.object),
      ...(brain?.relations ?? []).filter((x) => x.kind === 'runs_on').map((x) => x.peer),
    ];
  };

  it('stores the period the extractor gave each relation and serves the one that held at asOf', async () => {
    f.extractor.setScript({
      entities: [
        { name: 'brain', type: 'project' },
        { name: 'gpt-5.6-luna', type: 'asset' },
        { name: 'gpt-6-luna', type: 'asset' },
      ],
      facts: [],
      edges: [
        {
          fromEntityIndex: 0,
          toEntityIndex: 1,
          kind: 'runs_on',
          confidence: 0.9,
          endTime: '2026-09-24',
        },
        {
          fromEntityIndex: 0,
          toEntityIndex: 2,
          kind: 'runs_on',
          confidence: 0.9,
          eventTime: '2026-09-24',
        },
      ],
    });
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'chat',
        title: 'Модели',
        occurredAt: '2026-09-24T21:40:00.000Z',
        contextRef: { vertical: 'edge_time_e2e' },
        text: 'Михаил: до 24 сентября движок brain работал на gpt-5.6-luna, с 24 сентября — на gpt-6-luna.',
      });
    expect(r.status).toBe(201);

    const edges = await edgesOf();
    const iso = (v: unknown) => (v ? new Date(String(v)).toISOString().slice(0, 10) : null);
    expect(edges.map((e) => [e.to, iso(e.validFrom), iso(e.validUntil)])).toEqual([
      // Stated only as having ended: its start is unknown, not the write.
      ['gpt-5.6-luna', null, '2026-09-24'],
      ['gpt-6-luna', '2026-09-24', null],
    ]);

    expect(await relationsAt('2026-09-22T12:00:00Z')).toEqual(['gpt-5.6-luna']);
    expect(await relationsAt()).toEqual(['gpt-6-luna']);
  });
});
