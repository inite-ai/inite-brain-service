/**
 * Promotion keeps active memory VISIBLE — against a REAL SurrealDB
 * (audit 2026-09-06, F4).
 *
 * The audit's repro: five old open-ended `said` facts → `factsPromoted=5`
 * → five compacted originals and one active summary whose `validUntil`
 * was already in the past — so the default "actual now" search filter
 * dropped the summary AND the originals, and the memory vanished from
 * every public read surface. Preprod runs COMPACTION_PROMOTION_ENABLED=1.
 *
 * Pinned here through the PUBLIC surface, not the table:
 *   - after promotion, /v1/search returns the summary for the memory's
 *     content, and never a compacted original;
 *   - the summary is open-ended because its originals were, and the span
 *     of the summarised events is kept as `source.eventRange`;
 *   - the audit's own visibility query returns exactly the summary.
 */
import { AppFixture, createApp } from './app-fixture';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';
import { PromotionRunnerService } from '../src/compaction/promotion-runner.service';

describe('promotion summary visibility (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  /** Every fact the public search surfaced, across its per-entity hits. */
  const factsOf = (body: {
    results: Array<{ facts: Array<{ factId: string; predicate: string }> }>;
  }) => body.results.flatMap((hit) => hit.facts);

  beforeAll(async () => {
    // Read at service construction — must be set before createApp.
    process.env.COMPACTION_PROMOTION_ENABLED = '1';
    f = await createApp({ companyId: 'co_promotion_visibility_e2e' });
  });

  afterAll(async () => {
    delete process.env.COMPACTION_PROMOTION_ENABLED;
    if (f) await f.close();
  });

  it('an open-ended group folds into a summary the public search still returns', async () => {
    const surreal = f.app.get(SurrealService);
    const aged: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'promotion_visibility_subject' },
          predicate: 'said',
          object: `historic lease memory number ${i}`,
          validFrom: '2025-01-01',
          confidence: 0.9,
          source: { vertical: 'rent', recorder: 'bot' },
        });
      expect([200, 201]).toContain(res.status);
      aged.push(res.body.factId as string);
    }
    // Age the group past COMPACTION_PROMOTION_AGE_DAYS (180).
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`UPDATE knowledge_fact SET recordedAt = $recordedAt WHERE id INSIDE $ids`, {
        recordedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        ids: aged.map((id) => new StringRecordId(id)),
      });
    });

    // The memory is reachable BEFORE promotion.
    const before = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'historic lease memory' });
    expect([200, 201]).toContain(before.status);
    expect(factsOf(before.body).some((r) => aged.includes(r.factId))).toBe(true);

    const stats = await f.app.get(PromotionRunnerService).promoteCompany(f.companyId);
    expect(stats.groupsPromoted).toBe(1);
    expect(stats.factsPromoted).toBe(5);

    // ...and still reachable AFTER: the replacement answers, the originals
    // do not. This is the assertion the audit found false.
    const after = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'historic lease memory' });
    expect([200, 201]).toContain(after.status);
    const results = factsOf(after.body);
    expect(results.some((r) => r.predicate === 'summary_said')).toBe(true);
    expect(results.some((r) => aged.includes(r.factId))).toBe(false);

    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            predicate: string;
            status: string;
            validFrom: Date;
            validUntil?: Date | null;
            source: { kind: string; eventRange?: { from: string; to: string } };
          }>,
        ]
      >(
        `SELECT predicate, status, validFrom, validUntil, source FROM knowledge_fact
          WHERE predicate = 'summary_said'`,
      );
      const summaries = rows as Array<{
        predicate: string;
        status: string;
        validFrom: Date;
        validUntil?: Date | null;
        source: { kind: string; eventRange?: { from: string; to: string } };
      }>;
      expect(summaries).toHaveLength(1);
      const summary = summaries[0]!;
      expect(summary.status).toBe('active');
      // Open-ended originals → open-ended summary; not "expired at birth".
      expect(summary.validUntil ?? null).toBeNull();
      expect(new Date(summary.validFrom).toISOString()).toBe('2025-01-01T00:00:00.000Z');
      // The events' span survives as provenance.
      expect(summary.source.kind).toBe('promotion');
      expect(summary.source.eventRange).toEqual({
        from: '2025-01-01T00:00:00.000Z',
        to: '2025-01-01T00:00:00.000Z',
      });

      // The audit's own visibility probe: exactly the summary passes the
      // default actual-now filter; the five originals are compacted.
      const [visible] = await db.query<[Array<{ predicate: string }>]>(
        `SELECT predicate FROM knowledge_fact
          WHERE predicate INSIDE ['said', 'summary_said']
            AND validFrom <= time::now() AND (validUntil IS NONE OR validUntil > time::now())
            AND status != 'compacted'`,
      );
      expect((visible as Array<{ predicate: string }>).map((r) => r.predicate)).toEqual([
        'summary_said',
      ]);
      const [compacted] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM knowledge_fact WHERE predicate = 'said' AND status = 'compacted'`,
      );
      expect(compacted as unknown[]).toHaveLength(5);
    });
  });

  it('a group whose every member has closed folds into a summary closed at the latest close', async () => {
    const surreal = f.app.get(SurrealService);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'promotion_closed_subject' },
          predicate: 'said',
          object: `closed remark number ${i}`,
          validFrom: `2024-0${i}-01`,
          validUntil: `2024-0${i}-15`,
          confidence: 0.9,
          source: { vertical: 'rent', recorder: 'bot' },
        });
      expect([200, 201]).toContain(res.status);
      ids.push(res.body.factId as string);
    }
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`UPDATE knowledge_fact SET recordedAt = $recordedAt WHERE id INSIDE $ids`, {
        recordedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        ids: ids.map((id) => new StringRecordId(id)),
      });
    });
    const stats = await f.app.get(PromotionRunnerService).promoteCompany(f.companyId);
    // This group, plus whatever an earlier case left promotable in the tenant.
    expect(stats.factsPromoted).toBeGreaterThanOrEqual(5);

    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ validUntil?: Date | null; derivedFrom: unknown[] }>]>(
        `SELECT validUntil, derivedFrom FROM knowledge_fact
          WHERE predicate = 'summary_said' AND array::len(derivedFrom) = 5
            AND derivedFrom[0] INSIDE $ids`,
        { ids: ids.map((id) => new StringRecordId(id)) },
      );
      const summary = (rows as Array<{ validUntil?: Date | null }>)[0]!;
      // Closed history stays closed — the summary carries the validity the
      // originals had, which is exactly as (in)visible as they were.
      expect(new Date(summary.validUntil!).toISOString()).toBe('2024-05-15T00:00:00.000Z');
    });
  });
});
