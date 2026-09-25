/**
 * A fact holds until the day it stopped, end to end, against a real
 * SurrealDB.
 *
 * Production dogfood: "до 24 сентября движок brain работал на
 * gpt-5.6-luna; с 24 сентября — на gpt-6-luna" was filed as the one fact
 * `engine_model = gpt-6-luna` from the 24th — a fact could not say the
 * 5.6 value held UNTIL the 24th, so asOf=2026-09-22 had no answer. This
 * pins the whole path: the extractor's per-fact endTime lands as
 * validUntil (with an unknown start), the two values of one single-value
 * slot coexist because their intervals do not meet (0165), and the
 * search at asOf serves the value that held then while the current read
 * serves today's.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('fact end time (e2e)', () => {
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

  const factsOf = () =>
    f.app.get(SurrealService).withCompany(
      f.companyId,
      async (db) =>
        (
          await db.query<
            [Array<{ object: string; status: string; validFrom: unknown; validUntil?: unknown }>]
          >(
            `SELECT object, status, validFrom, validUntil FROM knowledge_fact
                WHERE predicate = 'engine_model' ORDER BY object`,
          )
        )[0] ?? [],
    );

  const valuesAt = async (asOf?: string) => {
    const r = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'на какой модели работает движок brain', ...(asOf ? { asOf } : {}) });
    expect(r.status).toBe(201);
    const hits = r.body.results as Array<{
      canonicalName: string;
      facts: Array<{ predicate: string; object: string }>;
    }>;
    const brain = hits.find((h) => h.canonicalName === 'brain');
    return (brain?.facts ?? []).filter((x) => x.predicate === 'engine_model').map((x) => x.object);
  };

  it('stores the period of each value and serves the one that held at asOf', async () => {
    f.extractor.setScript({
      entities: [{ name: 'brain', type: 'project' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'engine_model',
          object: 'gpt-5.6-luna',
          confidence: 0.9,
          endTime: '2026-09-24',
          cardinality: 'one',
        },
        {
          entityIndex: 0,
          predicate: 'engine_model',
          object: 'gpt-6-luna',
          confidence: 0.9,
          eventTime: '2026-09-24',
          cardinality: 'one',
        },
      ],
      edges: [],
    });
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'chat',
        title: 'Модели',
        occurredAt: '2026-09-24T21:40:00.000Z',
        contextRef: { vertical: 'fact_end_time_e2e' },
        text: 'Михаил: до 24 сентября движок brain работал на gpt-5.6-luna, с 24 сентября — на gpt-6-luna.',
      });
    expect(r.status).toBe(201);

    const iso = (v: unknown) => (v ? new Date(String(v)).toISOString().slice(0, 10) : null);
    expect(
      (await factsOf()).map((x) => [x.object, x.status, iso(x.validFrom), iso(x.validUntil)]),
    ).toEqual([
      // Stated only as having ended: the epoch sentinel start, not the write.
      ['gpt-5.6-luna', 'active', '1970-01-01', '2026-09-24'],
      ['gpt-6-luna', 'active', '2026-09-24', null],
    ]);

    expect(await valuesAt('2026-09-22T12:00:00Z')).toEqual(['gpt-5.6-luna']);
    expect(await valuesAt()).toEqual(['gpt-6-luna']);
  });

  it('the past value written AFTER the current one neither closes it nor becomes history', async () => {
    const at = (object: string, days: { eventTime?: string; endTime?: string }) => ({
      entities: [{ name: 'atlas', type: 'project' as const }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'atlas_model',
          object,
          confidence: 0.9,
          cardinality: 'one' as const,
          ...days,
        },
      ],
      edges: [],
    });
    const post = (text: string) =>
      f.http
        .post('/v1/ingest/document')
        .set(auth())
        .send({
          kind: 'chat',
          title: 'atlas',
          occurredAt: '2026-09-24T21:40:00.000Z',
          contextRef: { vertical: 'fact_end_time_e2e' },
          text,
        });
    f.extractor.setScript(at('gpt-6-luna', { eventTime: '2026-09-24' }));
    expect((await post('Since the 24th atlas runs on gpt-6-luna.')).status).toBe(201);
    f.extractor.setScript(at('gpt-5.6-luna', { endTime: '2026-09-24' }));
    expect((await post('Until the 24th atlas ran on gpt-5.6-luna.')).status).toBe(201);

    const rows = await f.app
      .get(SurrealService)
      .withCompany(
        f.companyId,
        async (db) =>
          (
            await db.query<[Array<{ object: string; status: string }>]>(
              `SELECT object, status FROM knowledge_fact WHERE predicate = 'atlas_model' ORDER BY object`,
            )
          )[0] ?? [],
      );
    expect(rows.map((x) => [x.object, x.status])).toEqual([
      ['gpt-5.6-luna', 'active'],
      ['gpt-6-luna', 'active'],
    ]);
  });

  it('a later turn ending a known open value closes that row — without supersedes', async () => {
    // state-transitions s01: "I bought a Kawasaki Ninja" then, a week later,
    // "I sold the Kawasaki today". The extractor files the sale as the value
    // with its end and names no known fact; the open row must still end.
    const own = (object: string, days: { eventTime?: string; endTime?: string }) => ({
      entities: [{ name: 'Sasha', type: 'customer' as const }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'owns_vehicle',
          object,
          confidence: 0.9,
          cardinality: 'many' as const,
          ...days,
        },
      ],
      edges: [],
    });
    const post = (text: string, occurredAt: string) =>
      f.http
        .post('/v1/ingest/document')
        .set(auth())
        .send({
          kind: 'chat',
          title: 'garage',
          occurredAt,
          contextRef: { vertical: 'fact_end_time_e2e' },
          text,
        });
    f.extractor.setScript(own('Kawasaki Ninja', { eventTime: '2026-08-01' }));
    expect(
      (await post('Sasha: I bought a Kawasaki Ninja on Saturday.', '2026-08-03T10:00:00Z')).status,
    ).toBe(201);
    f.extractor.setScript(own('Kawasaki', { endTime: '2026-08-10' }));
    expect((await post('Sasha: I sold the Kawasaki today.', '2026-08-10T17:00:00Z')).status).toBe(
      201,
    );

    const iso = (v: unknown) => (v ? new Date(String(v)).toISOString().slice(0, 10) : null);
    const rows = await f.app.get(SurrealService).withCompany(
      f.companyId,
      async (db) =>
        (
          await db.query<
            [Array<{ object: string; status: string; validFrom: unknown; validUntil?: unknown }>]
          >(
            `SELECT object, status, validFrom, validUntil FROM knowledge_fact
                WHERE predicate = 'owns_vehicle' ORDER BY object`,
          )
        )[0] ?? [],
    );
    expect(rows.map((x) => [x.object, x.status, iso(x.validFrom), iso(x.validUntil)])).toEqual([
      // The statement of the end is kept as the audit record of the open row.
      ['Kawasaki', 'corroborating', '1970-01-01', '2026-08-10'],
      ['Kawasaki Ninja', 'active', '2026-08-01', '2026-08-10'],
    ]);

    const owned = async (asOf?: string) => {
      const r = await f.http
        .post('/v1/search')
        .set(auth())
        .send({ query: 'what vehicle does Sasha own', ...(asOf ? { asOf } : {}) });
      expect(r.status).toBe(201);
      const hits = r.body.results as Array<{
        canonicalName: string;
        facts: Array<{ predicate: string; object: string }>;
      }>;
      return hits
        .flatMap((h) => h.facts ?? [])
        .filter((x) => x.predicate === 'owns_vehicle')
        .map((x) => x.object);
    };
    expect(await owned('2026-08-05T12:00:00Z')).toEqual(['Kawasaki Ninja']);
    expect(await owned()).toEqual([]);
  });
});
