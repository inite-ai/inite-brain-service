/**
 * Direct fact-ingest must sanitize meta on BOTH channels. dto.metadata
 * was already sanitized, but a raw `dto.source.meta` used to be copied
 * onto knowledge_fact.source.meta verbatim — an unfiltered write to the
 * ABAC match surface (and to the entity reads that echo `source`). This
 * pins that the source.meta channel goes through sanitizeSourceMeta too.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('fact-ingest sanitizes raw source.meta', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_source_meta_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('drops invalid keys/values from a raw source.meta blob', async () => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'source_meta_subject' },
        predicate: 'name',
        object: 'Source Meta Probe',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: {
          vertical: 'rent',
          recorder: 'bot',
          // No dto.metadata — the meta rides directly on source.
          meta: {
            'Bad Key!': 'should not persist', // invalid key → dropped
            data_class: 'pii', // valid → kept
            huge: 'x'.repeat(500), // >256 chars → dropped
          },
        },
      });
    expect([200, 201]).toContain(r.status);
    const factId = r.body.factId as string;

    const surreal = f.app.get(SurrealService);
    const meta = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ meta: unknown }>]>(
        `SELECT source.meta AS meta FROM type::record('knowledge_fact', $tail)`,
        { tail: factId.split(':')[1] },
      );
      return (rows as Array<{ meta: Record<string, unknown> | null }>)[0]?.meta;
    });

    // The valid key survived; the invalid ones never touched the graph.
    expect(meta).toBeTruthy();
    expect((meta as Record<string, unknown>).data_class).toBe('pii');
    expect(meta).not.toHaveProperty('Bad Key!');
    expect(meta).not.toHaveProperty('huge');
  });
});
