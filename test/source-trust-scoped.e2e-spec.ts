/**
 * e2e for the source-reputation track, Phase 2 (migration 0045):
 * domain-scoped source reputation.
 *
 *   1. fn::source_trust_scoped ladder: scoped row (>=8 samples) → global
 *      row (>=8) → neutral 0.5.
 *   2. The nightly refit aggregates at BOTH grains ((sourceKey, domain) +
 *      global) and appends to source_trust_history when a rate moves —
 *      and does NOT append when a re-run computes the same rate.
 *   3. fn::resolve_fact stamps trustSnapshot.learnedTrust through the
 *      SCOPED lookup — the same source gets different learned trust on a
 *      predicate it wins vs one it loses (the broker analogy).
 */
import { Surreal } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';
import { CalibrationRefitRunnerService } from '../src/ai/calibration/calibration-refit-runner.service';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

const SRC = { vertical: 'rent', recorder: 'flaky_bot' };
const KEY = 'rent:flaky_bot';

describe('domain-scoped source trust (Phase 2)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const withDb = async <T>(fn: (db: Surreal) => Promise<T>) =>
    f.app.get(SurrealService).withCompany(f.companyId, fn);

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_scoped_trust_e2e' });

    // Seed raw history for one source: 8 ACTIVE `status` facts (all wins)
    // and 4 SUPERSEDED `address` facts (all losses). Directly via the DB —
    // the refit reads fact rows, not the ingest path.
    await withDb(async (db) => {
      const [ent] = await db.query<[{ id: unknown }]>(
        `CREATE ONLY knowledge_entity CONTENT {
           type: 'customer',
           canonicalName: 'Scoped Trust Seed'
         }`,
      );
      const entityId = String((ent as { id: unknown }).id);
      const tail = entityId.split(':')[1];
      for (let i = 0; i < 8; i++) {
        await db.query(
          `CREATE knowledge_fact CONTENT {
             entityId: type::record('knowledge_entity', $eid),
             predicate: 'status',
             object: 'ok_' + <string>$i,
             confidence: 0.9,
             validFrom: d'2026-01-01T00:00:00Z',
             source: $src,
             status: 'active'
           }`,
          { eid: tail, i, src: SRC },
        );
      }
      for (let i = 0; i < 4; i++) {
        await db.query(
          `CREATE knowledge_fact CONTENT {
             entityId: type::record('knowledge_entity', $eid),
             predicate: 'address',
             object: 'wrong_' + <string>$i,
             confidence: 0.9,
             validFrom: d'2026-01-01T00:00:00Z',
             source: $src,
             status: 'superseded',
             retractionReason: 'superseded',
             retractedBy: 'system'
           }`,
          { eid: tail, i, src: SRC },
        );
      }
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('refit writes both grains + history; re-run stays quiet', async () => {
    const runner = f.app.get(CalibrationRefitRunnerService);
    await runner.refitSourceTrust();

    const rows = await withDb(async (db) => {
      const [r] = await db.query<[any[]]>(
        `SELECT sourceKey, domain, agreementRate, sampleCount, winCount, lossCount, lastSeenAt
           FROM source_trust WHERE sourceKey = $k`,
        { k: KEY },
      );
      return r as any[];
    });
    const byDomain = new Map(rows.map((r) => [r.domain ?? null, r]));

    // Scoped: perfect on `status`, hopeless on `address` — never blended.
    expect(byDomain.get('status')).toMatchObject({
      agreementRate: 1,
      sampleCount: 8,
      winCount: 8,
      lossCount: 0,
    });
    expect(byDomain.get('address')).toMatchObject({
      agreementRate: 0,
      sampleCount: 4,
    });
    // Global row = the blended pre-0045 semantics (8 wins / 4 losses).
    expect(byDomain.get(null).agreementRate).toBeCloseTo(8 / 12);
    expect(byDomain.get(null).sampleCount).toBe(12);
    expect(byDomain.get(null).lastSeenAt).toBeDefined();

    // First sighting → history rows for every scope of this source.
    const historyCount = async () =>
      withDb(async (db) => {
        const [h] = await db.query<[any[]]>(
          `SELECT id FROM source_trust_history WHERE sourceKey = $k`,
          { k: KEY },
        );
        return (h as any[]).length;
      });
    const afterFirst = await historyCount();
    expect(afterFirst).toBeGreaterThanOrEqual(3);

    // Re-run with identical data: rates unchanged → NO new history rows
    // (the |Δ| > 0.01 gate).
    await runner.refitSourceTrust();
    expect(await historyCount()).toBe(afterFirst);
  });

  it('fn::source_trust_scoped resolves scoped → global → 0.5', async () => {
    const lookup = (domain: string) =>
      withDb(async (db) => {
        const [v] = await db.query<[number]>(`RETURN fn::source_trust_scoped($k, $d)`, {
          k: KEY,
          d: domain,
        });
        return v as number;
      });

    // Scoped row with >=8 samples wins.
    expect(await lookup('status')).toBeCloseTo(1.0);
    // Scoped row exists but <8 samples → falls to the global rate.
    expect(await lookup('address')).toBeCloseTo(8 / 12);
    // No scoped row at all → global.
    expect(await lookup('tier')).toBeCloseTo(8 / 12);

    // Unknown source entirely → neutral.
    const neutral = await withDb(async (db) => {
      const [v] = await db.query<[number]>(
        `RETURN fn::source_trust_scoped('nowhere:nobody', 'status')`,
      );
      return v as number;
    });
    expect(neutral).toBeCloseTo(0.5);
  });

  it('resolve_fact stamps learnedTrust through the scoped ladder', async () => {
    const ingest = (predicate: string, object: string) =>
      f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'scoped_trust_customer' },
          predicate,
          object,
          validFrom: '2026-06-01T00:00:00Z',
          source: SRC,
          confidence: 0.9,
        });

    const factRow = async (factId: string) =>
      withDb(async (db) => {
        const [rows] = await db.query<[any[]]>(
          `SELECT trustSnapshot FROM type::record('knowledge_fact', $rid)`,
          { rid: factId.split(':')[1] },
        );
        return (rows as any[])?.[0];
      });

    // Same source, different domains: the snapshot records the scoped
    // reputation — high where it wins, blended-global where it has no
    // usable scoped history.
    const onStatus = await ingest('status', 'premium');
    const statusRow = await factRow(onStatus.body.factId);
    expect(statusRow.trustSnapshot.learnedTrust).toBeCloseTo(1.0);
    expect(statusRow.trustSnapshot.domain).toBe('status');

    const onTier = await ingest('tier', 'gold');
    const tierRow = await factRow(onTier.body.factId);
    expect(tierRow.trustSnapshot.learnedTrust).toBeCloseTo(8 / 12);
  });
});
