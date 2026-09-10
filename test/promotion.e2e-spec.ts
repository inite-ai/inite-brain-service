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
import type { SummaryGenerator } from '../src/compaction/summary-generator';

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
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
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
      await db.query(`UPDATE knowledge_fact SET recordedAt = $recordedAt WHERE id INSIDE $ids`, {
        recordedAt,
        ids: factIds.map((id) => new StringRecordId(id)),
      });
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

  it('a member retracted inside the summarise window skips the group instead of promoting it', async () => {
    // The members are selected BEFORE the awaited summary + embedding
    // window. The close used to be unconditional (`WHERE id INSIDE $ids`,
    // no row-count check), so a member retracted in that window was
    // flipped to 'compacted' with its content already inside the summary
    // — and a second pass could add a second active summary over the
    // same derivedFrom. The full predicate plus the count check makes the
    // whole transaction abort.
    const aged: string[] = [];
    for (let i = 1; i <= 5; i++) {
      aged.push(await ingest('complained_about', `race remark number ${i}`));
    }
    await backdate(aged, 365);
    const victim = aged[0]!;

    const svc = f.app.get(PromotionRunnerService);
    const seam = svc as unknown as { summaryGenerator: SummaryGenerator };
    const real = seam.summaryGenerator;
    const surreal = f.app.get(SurrealService);
    let retracted = false;
    seam.summaryGenerator = {
      generate: async (group) => {
        if (!retracted) {
          retracted = true;
          await surreal.withCompany(f.companyId, async (db) => {
            await db.query(
              `UPDATE type::record('knowledge_fact', $tail)
                 SET status = 'retracted', retractedAt = time::now()`,
              { tail: victim.split(':')[1] },
            );
          });
        }
        return real.generate(group);
      },
    };
    let stats;
    try {
      stats = await svc.promoteCompany(f.companyId);
    } finally {
      seam.summaryGenerator = real;
    }
    expect(retracted).toBe(true);
    expect(stats.groupsPromoted).toBe(0);
    expect(stats.factsPromoted).toBe(0);

    await surreal.withCompany(f.companyId, async (db) => {
      const [summaries] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_fact WHERE predicate = 'summary_complained_about'`,
      );
      expect(summaries as Array<{ id: unknown }>).toHaveLength(0);
      const [rows] = await db.query<[Array<{ id: unknown; status: string }>]>(
        `SELECT id, status FROM knowledge_fact WHERE id INSIDE $ids`,
        { ids: aged.map((id) => new StringRecordId(id)) },
      );
      const byId = new Map(
        (rows as Array<{ id: unknown; status: string }>).map((r) => [String(r.id), r.status]),
      );
      // The retracted member stays retracted; the survivors stay active —
      // nothing was closed under a summary that never landed.
      expect(byId.get(victim)).toBe('retracted');
      for (const id of aged.slice(1)) expect(byId.get(id)).toBe('active');
    });
  });
});
