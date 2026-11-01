/**
 * e2e for the source-reputation track, Phase 2 (migration 0045):
 * domain-scoped source reputation.
 *
 *   1. fn::source_trust_scoped ladder: scoped row (>=8 samples) → global
 *      row (>=8) → neutral 0.5.
 *   2. The nightly truth-discovery pass (#847) estimates accuracy at BOTH
 *      grains ((sourceKey, domain) + the source across domains) and
 *      appends to source_trust_history when a rate moves — and does NOT
 *      append when a re-run computes the same rate.
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
const REF = { vertical: 'rent', recorder: 'ref_a' };
const REF2 = { vertical: 'rent', recorder: 'ref_b' };
const KEY = 'rent:flaky_bot';

describe('domain-scoped source trust (Phase 2)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const withDb = async <T>(fn: (db: Surreal) => Promise<T>) =>
    f.app.get(SurrealService).withCompany(f.companyId, fn);

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_scoped_trust_e2e' });

    // One source, two domains, judged against two reference sources:
    // on 8 `status` slots it agrees with them (right), on 4 `address`
    // slots it names a value both references contradict (wrong). Each slot
    // is its own entity. Directly via the DB: the pass reads fact rows,
    // not the ingest path.
    await withDb(async (db) => {
      const claim = async (eid: string, predicate: string, object: string, src: object) =>
        db.query(
          `CREATE knowledge_fact CONTENT {
             entityId: type::record('knowledge_entity', $eid),
             predicate: $predicate,
             object: $object,
             confidence: 0.9,
             validFrom: d'2026-01-01T00:00:00Z',
             source: $src,
             status: 'active'
           }`,
          { eid, predicate, object, src },
        );
      const entity = async (name: string) => {
        const [ent] = await db.query<[{ id: unknown }]>(
          `CREATE ONLY knowledge_entity CONTENT { type: 'customer', canonicalName: $name }`,
          { name },
        );
        return String((ent as { id: unknown }).id).split(':')[1]!;
      };
      for (let i = 0; i < 8; i++) {
        const eid = await entity(`status seed ${i}`);
        await claim(eid, 'status', 'ok', SRC);
        await claim(eid, 'status', 'ok', REF);
      }
      for (let i = 0; i < 4; i++) {
        const eid = await entity(`address seed ${i}`);
        await claim(eid, 'address', 'wrong', SRC);
        await claim(eid, 'address', 'right', REF);
        await claim(eid, 'address', 'right', REF2);
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

    // Scoped: reliable on `status`, unreliable on `address` — never blended;
    // the source across domains sits between the two.
    const status = byDomain.get('status');
    const address = byDomain.get('address');
    const global = byDomain.get(null);
    expect(status).toMatchObject({ sampleCount: 8, winCount: 8, lossCount: 0 });
    expect(address).toMatchObject({ sampleCount: 4 });
    expect(global.sampleCount).toBe(12);
    // Four wrong votes in a domain move it below the source's record
    // elsewhere without erasing that record: the domain shrinks towards
    // the source across domains, not towards 0.5.
    expect(status.agreementRate).toBeGreaterThan(0.6);
    expect(address.agreementRate).toBeLessThan(global.agreementRate);
    expect(global.agreementRate).toBeLessThan(status.agreementRate);
    expect(global.lastSeenAt).toBeDefined();

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

  const rateOf = (domain: string | null) =>
    withDb(async (db) => {
      const [r] = await db.query<[Array<{ agreementRate: number }>]>(
        `SELECT agreementRate FROM source_trust WHERE sourceKey = $k
           AND ((domain IS NONE AND $d IS NONE) OR domain = $d)`,
        { k: KEY, d: domain ?? undefined },
      );
      return (r as Array<{ agreementRate: number }>)[0]!.agreementRate;
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
    expect(await lookup('status')).toBeCloseTo(await rateOf('status'));
    // Scoped row exists but <8 samples → falls to the global rate.
    expect(await lookup('address')).toBeCloseTo(await rateOf(null));
    // No scoped row at all → global.
    expect(await lookup('tier')).toBeCloseTo(await rateOf(null));

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
    expect(statusRow.trustSnapshot.learnedTrust).toBeCloseTo(await rateOf('status'));
    expect(statusRow.trustSnapshot.domain).toBe('status');

    const onTier = await ingest('tier', 'gold');
    const tierRow = await factRow(onTier.body.factId);
    expect(tierRow.trustSnapshot.learnedTrust).toBeCloseTo(await rateOf(null));
  });
});
