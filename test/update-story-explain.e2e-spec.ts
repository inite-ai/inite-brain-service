/**
 * Regression guard for the update-story reverse lookup plan (V11 §5
 * scale gate): `supersededBy IN $w` — with $w a LET-derived array of
 * record ids, the exact shape update-story.service.ts issues — must
 * plan through fact_superseded_by_idx (0059), not a table scan.
 * Verified manually on the loco stand (SurrealDB 3.1.5: IndexScan,
 * access "= knowledge_fact:…"); this pins it across server bumps.
 * The plan is shape-dependent, not data-dependent, so no seeding.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('update-story reverse lookup plan (real SurrealDB)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_upd_explain_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('supersededBy IN $w uses fact_superseded_by_idx', async () => {
    const surreal = f.app.get(SurrealService);
    const plan = await surreal.withCompany(f.companyId, async (db) => {
      const res = await db.query(
        `LET $w = $winners.map(|$x| type::record($x));
         SELECT id, supersededBy, object, validUntil FROM knowledge_fact
          WHERE supersededBy IN $w
            AND status = 'superseded'
            AND retractedAt IS NONE
          ORDER BY validUntil DESC EXPLAIN`,
        { winners: ['knowledge_fact:probe_winner'] },
      );
      return JSON.stringify(res[1]);
    });
    expect(plan).toContain('fact_superseded_by_idx');
    expect(plan).toContain('IndexScan');
    expect(plan).not.toContain('TableScan');
  });
});
