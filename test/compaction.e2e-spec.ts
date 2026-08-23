/**
 * Compaction retention pass against a REAL SurrealDB — regression for
 * the `d$cutoff` 2.x idiom that SurrealDB 3.x fails to parse: every
 * nightly compaction threw (log-and-skip) since the 3.1.5 upgrade, and
 * no e2e exercised the query. A closed-out fact past the retention
 * window must come back status='compacted' with its embedding dropped.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { CompactionService } from '../src/compaction/compaction.service';

describe('compaction retention pass (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_compaction_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('compacts a fact whose validity closed past the retention window', async () => {
    const ingest = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'compaction_subject' },
      predicate: 'claim_probe',
      object: 'a claim that expired long ago',
      validFrom: '2024-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
    });
    expect([200, 201]).toContain(ingest.status);
    const factId = ingest.body.factId as string;

    // Close the interval far past COMPACTION_HOT_RETENTION_DAYS (90).
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE type::record('knowledge_fact', $tail)
           SET validUntil = $closedAt`,
        {
          tail: factId.split(':')[1],
          closedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
        },
      );
    });

    const stats = await f.app
      .get(CompactionService)
      .compactCompany(f.companyId);
    expect(stats.factsCompacted).toBeGreaterThanOrEqual(1);

    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<
        [Array<{ status: string; embedding: unknown }>]
      >(
        `SELECT status, embedding FROM type::record('knowledge_fact', $tail)`,
        { tail: factId.split(':')[1] },
      );
      const fact = (rows as Array<{ status: string; embedding: unknown }>)[0]!;
      expect(fact.status).toBe('compacted');
      expect(fact.embedding ?? null).toBeNull();
    });
  });
});
