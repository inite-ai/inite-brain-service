/**
 * Episodic→semantic promotion against a REAL SurrealDB: an aged group
 * of append_only facts folds into one embedded, ACTIVE
 * `summary_<predicate>` fact with `derivedFrom` provenance; the aged
 * originals become `compacted`; fresh group members stay active;
 * non-append_only predicates are never touched.
 */
import { AppFixture, createApp } from './app-fixture';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';
import { PromotionRunnerService } from '../src/compaction/promotion-runner.service';

describe('episodic→semantic promotion (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    // Read at service construction — must be set before createApp.
    process.env.COMPACTION_PROMOTION_ENABLED = '1';
    f = await createApp({ companyId: 'co_promotion_e2e' });
  });

  afterAll(async () => {
    delete process.env.COMPACTION_PROMOTION_ENABLED;
    if (f) await f.close();
  });

  const ingest = async (predicate: string, object: string) => {
    const res = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'promo_subject' },
      predicate,
      object,
      validFrom: '2025-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
    });
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  };

  const backdate = async (factIds: string[], days: number) => {
    const surreal = f.app.get(SurrealService);
    const recordedAt = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE knowledge_fact SET recordedAt = $recordedAt WHERE id INSIDE $ids`,
        { recordedAt, ids: factIds.map((id) => new StringRecordId(id)) },
      );
    });
  };

  it('folds the aged tail into an embedded summary; fresh + non-append_only stay', async () => {
    // 5 aged 'said' events (append_only) + 1 fresh one.
    const aged: string[] = [];
    for (let i = 1; i <= 5; i++) {
      aged.push(await ingest('said', `old remark number ${i} about the lease`));
    }
    const fresh = await ingest('said', 'fresh remark that must stay active');
    await backdate(aged, 365);

    // Control group: 5 aged facts on a COINED (not-in-seed) predicate —
    // never promoted no matter the age. Coined predicates write as
    // append_only since 0082, but promotion folds only seed-declared
    // append_only event history; specific observations stay verbatim.
    const control: string[] = [];
    for (let i = 1; i <= 5; i++) {
      control.push(await ingest('claim_probe', `unrelated claim ${i}`));
    }
    await backdate(control, 365);

    const svc = f.app.get(PromotionRunnerService);
    const stats = await svc.promoteCompany(f.companyId);
    expect(stats.groupsPromoted).toBe(1);
    expect(stats.factsPromoted).toBe(5);

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [summaryRows] = await db.query<
        [
          Array<{
            status: string;
            object: string;
            derivedFrom: unknown[];
            embedding: number[] | null;
          }>,
        ]
      >(
        `SELECT status, object, derivedFrom, embedding FROM knowledge_fact
          WHERE predicate = 'summary_said'`,
      );
      const summaries = summaryRows as Array<{
        status: string;
        object: string;
        derivedFrom: unknown[];
        embedding: number[] | null;
      }>;
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.status).toBe('active');
      expect(summaries[0]!.object.length).toBeGreaterThan(0);
      expect(summaries[0]!.derivedFrom).toHaveLength(5);
      // Promotion summaries are embedded — they replace active memory
      // and must stay vector-reachable.
      expect(Array.isArray(summaries[0]!.embedding)).toBe(true);

      const statusOf = async (id: string) => {
        const [rows] = await db.query<[Array<{ status: string }>]>(
          `SELECT status FROM type::record('knowledge_fact', $tail)`,
          { tail: id.split(':')[1] },
        );
        return (rows as Array<{ status: string }>)[0]?.status;
      };
      for (const id of aged) expect(await statusOf(id)).toBe('compacted');
      expect(await statusOf(fresh)).toBe('active');
      for (const id of control) expect(await statusOf(id)).toBe('active');
    });

    // Idempotent: the promoted tail is compacted now, nothing new to fold.
    const again = await svc.promoteCompany(f.companyId);
    expect(again.groupsPromoted).toBe(0);
  });
});
