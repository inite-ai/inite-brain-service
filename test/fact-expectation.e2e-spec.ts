/**
 * Foresight (0166) end to end, against a real SurrealDB: a temporary
 * state's expectation lands on the fact row from both write paths, a
 * restatement moves it, it never closes the fact, and search returns it.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { MemoryDiffService } from '../src/diff/memory-diff.service';

describe('fact expectation (e2e)', () => {
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

  const script = (subject: string, object: string, expectedEnd?: string) => ({
    entities: [{ name: subject, type: 'staff' as const }],
    facts: [
      {
        entityIndex: 0,
        predicate: 'health_state',
        object,
        confidence: 0.9,
        cardinality: 'one' as const,
        ...(expectedEnd ? { expectedEnd } : {}),
      },
    ],
    edges: [],
  });

  const rowsOf = (object: string) =>
    f.app.get(SurrealService).withCompany(
      f.companyId,
      async (db) =>
        (
          await db.query<
            [
              Array<{
                status: string;
                validFrom: unknown;
                validUntil?: unknown;
                expectedUntil?: unknown;
              }>,
            ]
          >(
            `SELECT status, validFrom, validUntil, expectedUntil FROM knowledge_fact
              WHERE object = $object AND status != 'corroborating' ORDER BY validFrom`,
            { object },
          )
        )[0] ?? [],
    );

  const day = (v: unknown) => (v ? new Date(String(v)).toISOString().slice(0, 10) : null);

  const mention = (text: string, emittedAt: string, messageId: string) =>
    f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text,
        emittedAt,
        contextRef: { vertical: 'chat', conversationId: 'c-expect', messageId },
      })
      .expect(201);

  it('a mention stamps the expectation; the fact stays open and search returns it', async () => {
    f.extractor.setScript(script('Rui', 'flu', '2026-10-02'));
    await mention('Rui: у меня грипп, неделю буду дома.', '2026-09-25T10:00:00.000Z', 'm1');

    const rows = await rowsOf('flu');
    expect(rows.map((r) => [r.status, day(r.validUntil), day(r.expectedUntil)])).toEqual([
      ['active', null, '2026-10-02'],
    ]);

    const r = await f.http.post('/v1/search').set(auth()).send({ query: 'Rui health flu' });
    expect(r.status).toBe(201);
    const facts = (r.body.results as Array<{ facts: Array<Record<string, unknown>> }>).flatMap(
      (h) => h.facts,
    );
    const flu = facts.find((x) => x.object === 'flu');
    expect(flu?.expectedUntil).toBe('2026-10-02T00:00:00.000Z');
    expect(flu?.validUntil).toBeUndefined();
  });

  it('"still sick" with a new expectation moves it on every row of the state', async () => {
    // A coined predicate is append-only, so the restatement is a second
    // row; the first must not keep reading "expected over by 10-02".
    f.extractor.setScript(script('Rui', 'flu', '2026-10-08'));
    await mention('Rui: всё ещё болею, ещё неделя.', '2026-10-01T10:00:00.000Z', 'm2');

    const rows = await rowsOf('flu');
    expect(rows.map((r) => [r.status, day(r.validUntil), day(r.expectedUntil)])).toEqual([
      ['active', null, '2026-10-08'],
      ['active', null, '2026-10-08'],
    ]);
  });

  it('a later re-read of the first statement does not pull the expectation back', async () => {
    f.extractor.setScript(script('Rui', 'flu', '2026-10-02'));
    await mention('Rui: у меня грипп, неделю буду дома.', '2026-09-25T10:00:00.000Z', 'm1-reread');
    const rows = await rowsOf('flu');
    expect(rows.every((r) => day(r.expectedUntil) === '2026-10-08')).toBe(true);
  });

  it('an expectation already behind the turn is not stamped', async () => {
    f.extractor.setScript(script('Ana', 'cold', '2026-09-20'));
    await mention('Ana: простыла.', '2026-09-25T10:00:00.000Z', 'm3');
    const rows = await rowsOf('cold');
    expect(rows.map((r) => r.expectedUntil ?? null)).toEqual([null]);
  });

  it('the document path stamps it too', async () => {
    f.extractor.setScript(script('Pedro', 'trip to Lisbon', '2026-09-28'));
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'chat',
        title: 'Командировка',
        occurredAt: '2026-09-25T09:00:00.000Z',
        contextRef: { vertical: 'fact_expectation_e2e' },
        text: 'Pedro: улетаю в Лиссабон на конференцию.',
      });
    expect(r.status).toBe(201);
    const rows = await rowsOf('trip to Lisbon');
    expect(rows.map((x) => [x.status, day(x.expectedUntil)])).toEqual([['active', '2026-09-28']]);
  });

  const recordFact = (object: string, days: Record<string, string>) =>
    f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'crm', id: 'lead_expect' },
        predicate: 'availability',
        object,
        confidence: 0.9,
        source: { vertical: 'crm', recorder: 'agent' },
        ...days,
      });

  it('record_fact carries an expectation; with a stated end or before the start it is refused', async () => {
    const ok = await recordFact('on parental leave', {
      validFrom: '2026-01-05T00:00:00Z',
      expectedUntil: '2026-01-19T00:00:00Z',
    });
    expect([200, 201]).toContain(ok.status);
    expect(day((await rowsOf('on parental leave'))[0]?.expectedUntil)).toBe('2026-01-19');

    const both = await recordFact('at a conference', {
      validFrom: '2026-01-05T00:00:00Z',
      validUntil: '2026-01-07T00:00:00Z',
      expectedUntil: '2026-01-07T00:00:00Z',
    });
    expect(both.status).toBe(400);
    const before = await recordFact('travelling', {
      validFrom: '2026-01-05T00:00:00Z',
      expectedUntil: '2026-01-04T00:00:00Z',
    });
    expect(before.status).toBe(400);
  });

  it('memory_diff reports a lapsed expectation in its window, and not one still ahead', async () => {
    await recordFact('on a sailing trip', {
      validFrom: '2026-09-01T00:00:00Z',
      expectedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    const diff = (from: string, to: string) =>
      f.app
        .get(MemoryDiffService)
        .diff(f.companyId, { from, to }, ['brain:read', 'brain:read_pii']);
    const january = await diff('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
    expect(january.lapsedExpectations.map((x) => x.object)).toEqual(['on parental leave']);
    expect(january.lapsedExpectations[0]?.expectedUntil).toBe('2026-01-19T00:00:00.000Z');
    const february = await diff('2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z');
    expect(february.lapsedExpectations).toEqual([]);
    const ahead = await diff(
      '2026-09-01T00:00:00Z',
      new Date(Date.now() + 30 * 86_400_000).toISOString(),
    );
    expect(ahead.lapsedExpectations.map((x) => x.object)).not.toContain('on a sailing trip');
  });
});
