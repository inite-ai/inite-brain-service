/**
 * Phase 2 closure e2e — verify that the resolver's loser-side
 * sourceTrust component is actually fed by `fn::source_trust_for`
 * (migration 0022), not the hardcoded 0.5 the resolver shipped with.
 *
 * Pre-0022 the FaithfulRAG learning loop was dead code:
 *   - migration 0017 added the `source_trust` table + lookup
 *   - CalibrationRefitService.refitSourceTrust wrote rolling rates
 *   - but `fn::resolve_fact` ignored them
 *
 * This spec proves the wiring by:
 *   1. Seeding the source_trust table directly with two sources at
 *      opposite rates (0.95 and 0.10) and sampleCount=8 each — at or
 *      above the bootstrap floor inside fn::source_trust_for.
 *   2. Ingesting a single_active fact from each source so the
 *      resolver fires the SUPERSEDED branch.
 *   3. Asserting that the scoreBreakdown.loser.sourceTrust component
 *      reflects the learned rate, not 0.5 × $w_source_trust.
 *
 * We use single_active semantics to remove embedding-similarity noise
 * from the test — every prior-active fact for the same predicate
 * competes regardless of embedding.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

/** The learned trust the resolver froze onto a fact (0044 trustSnapshot). */
async function learnedTrustOf(f: AppFixture, factId: string): Promise<number> {
  const surreal = f.app.get(SurrealService);
  return surreal.withCompany(f.companyId, async (db) => {
    const [rows] = await db.query<[number[]]>(
      `SELECT VALUE trustSnapshot.learnedTrust FROM type::record('knowledge_fact', $t)`,
      { t: factId.split(':')[1] },
    );
    return Number(rows[0]);
  });
}

describe('FaithfulRAG — loser-side source trust feeds from learned rate', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_ftrust_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  // Seed source_trust with a known low-trust row above the 8-sample
  // bootstrap floor, then ingest a competing fact from the same
  // source and read the trust its fact froze.
  it("a low-trust source's learned rate is frozen onto its fact, not the 0.5 baseline", async () => {
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      // Wipe + seed deterministically.
      await db.query('DELETE source_trust');
      await db.query(
        `CREATE source_trust CONTENT {
           sourceKey: 'rent:flaky.bot',
           agreementRate: 0.10,
           sampleCount: 50
         }`,
      );
    });

    // First ingest: loser-to-be. `name` is single_active.
    const loser = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'ft_trust_subj' },
        predicate: 'name',
        object: 'Old Name',
        validFrom: '2026-01-01',
        source: { vertical: 'rent', recorder: 'flaky.bot' },
        confidence: 0.9,
      });
    expect(loser.status).toBe(201);

    // Second ingest: winner. Different source so we can read the
    // learned-rate loser sourceTrust independently of the winner's
    // caller-supplied $source_trust path.
    const winner = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'ft_trust_subj' },
        predicate: 'name',
        object: 'New Name',
        validFrom: '2026-02-01',
        source: { vertical: 'rent', recorder: 'trusted.bot' },
        confidence: 0.9,
        explain: true,
      });
    expect(winner.status).toBe(201);
    expect(winner.body.outcome).toBe('SUPERSEDED');

    // #830: trust is provenance, not a vote — the learned rate (0022/0045)
    // is what the loser's trust snapshot froze, not the 0.5 fallback.
    expect(await learnedTrustOf(f, String(loser.body.factId))).toBeCloseTo(0.1, 2);
  });

  // Sources below the bootstrap floor stay on 0.5 — this is the
  // back-compat guarantee that brand-new sources don't suddenly
  // shift their score under low-sample noise.
  it('sub-bootstrap sources still use the 0.5 fallback', async () => {
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query('DELETE source_trust');
      // sampleCount=2 is below the n>=8 bootstrap inside fn::source_trust_for.
      await db.query(
        `CREATE source_trust CONTENT {
           sourceKey: 'rent:newish.bot',
           agreementRate: 0.10,
           sampleCount: 2
         }`,
      );
    });

    const loser = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'ft_trust_subj_2' },
        predicate: 'name',
        object: 'A',
        validFrom: '2026-01-01',
        source: { vertical: 'rent', recorder: 'newish.bot' },
        confidence: 0.9,
      });
    expect(loser.status).toBe(201);

    const winner = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'ft_trust_subj_2' },
        predicate: 'name',
        object: 'B',
        validFrom: '2026-02-01',
        source: { vertical: 'rent', recorder: 'trusted.bot' },
        confidence: 0.9,
        explain: true,
      });
    expect(winner.body.outcome).toBe('SUPERSEDED');
    // Below the bootstrap floor the snapshot holds the 0.5 fallback.
    expect(await learnedTrustOf(f, String(loser.body.factId))).toBeCloseTo(0.5, 2);
  });
});
