/**
 * FactsService.listCompeting — integration smoke
 *
 * Seeds a knowledge_entity + a competing pair (two facts in
 * status='competing' sharing a predicate) plus a non-competing active
 * fact, then asserts:
 *   - the competing pair is returned as one group of 2
 *   - the active fact is excluded
 *   - filtering by predicate narrows the result
 *   - asOf < competing.recordedAt excludes the pair
 *
 * Direct DB seed instead of the ingest path because forcing the
 * conflict resolver into COMPETING requires similarity tuning that
 * isn't deterministic under the stub embedder.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { FactsService } from '../src/facts/facts.service';

const ENT_ID = 'lc_subj';
const ENT_FULL = `knowledge_entity:${ENT_ID}`;

describe('FactsService.listCompeting — groups competing pairs by predicate', () => {
  let f: AppFixture;
  let now: Date;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_listcompeting_e2e' });
    now = new Date();

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE type::record('knowledge_entity', $eid) CONTENT {
            type: 'customer',
            canonicalName: 'List Competing Subject',
            externalRefs: { rent: 'lc_subj' }
         }`,
        { eid: ENT_ID },
      );

      // Two competing facts on `status`.
      const recordedA = new Date(now.getTime() - 2_000);
      const recordedB = new Date(now.getTime() - 1_000);
      await db.query(
        `CREATE knowledge_fact:lc_a CONTENT {
            entityId: type::record('knowledge_entity', $eid),
            predicate: 'status',
            object: 'active',
            confidence: 0.7,
            validFrom: $vf,
            recordedAt: $ra,
            status: 'competing',
            source: { vertical: 'rent', recorder: 'bot_a' }
         }`,
        { eid: ENT_ID, vf: new Date('2026-01-01'), ra: recordedA },
      );
      await db.query(
        `CREATE knowledge_fact:lc_b CONTENT {
            entityId: type::record('knowledge_entity', $eid),
            predicate: 'status',
            object: 'churned',
            confidence: 0.72,
            validFrom: $vf,
            recordedAt: $ra,
            status: 'competing',
            source: { vertical: 'rent', recorder: 'bot_b' }
         }`,
        { eid: ENT_ID, vf: new Date('2026-01-01'), ra: recordedB },
      );

      // A non-competing fact on the same entity — must be excluded.
      await db.query(
        `CREATE knowledge_fact:lc_c CONTENT {
            entityId: type::record('knowledge_entity', $eid),
            predicate: 'tier',
            object: 'gold',
            confidence: 0.95,
            validFrom: $vf,
            recordedAt: $ra,
            status: 'active',
            source: { vertical: 'rent', recorder: 'bot_c' }
         }`,
        { eid: ENT_ID, vf: new Date('2026-01-01'), ra: now },
      );
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('returns the competing pair as one group, excluding the active fact', async () => {
    const facts = f.app.get(FactsService);
    const out = await facts.listCompeting(f.companyId, ENT_ID);

    expect(out.entityId).toBe(ENT_FULL);
    expect(out.groups).toHaveLength(1);
    const [group] = out.groups;
    expect(group.predicate).toBe('status');
    expect(group.entityId).toBe(ENT_FULL);
    expect(group.facts).toHaveLength(2);
    const objects = group.facts.map((f) => f.object).sort();
    expect(objects).toEqual(['active', 'churned']);
    // recordedAt-ascending order preserved.
    expect(group.facts[0].factId).toBe('knowledge_fact:lc_a');
    expect(group.facts[1].factId).toBe('knowledge_fact:lc_b');
  });

  it('filters to the requested predicate only', async () => {
    const facts = f.app.get(FactsService);
    const out = await facts.listCompeting(f.companyId, ENT_ID, {
      predicate: 'tier',
    });
    // `tier` row is status='active'; no competing rows for that predicate.
    expect(out.groups).toHaveLength(0);
  });

  it('honors asOf: pre-competing-recordedAt cutoff returns nothing', async () => {
    const facts = f.app.get(FactsService);
    const cutoff = new Date(now.getTime() - 10_000).toISOString();
    const out = await facts.listCompeting(f.companyId, ENT_ID, {
      asOf: cutoff,
    });
    expect(out.groups).toHaveLength(0);
    expect(out.asOf).toBe(cutoff);
  });

  it('accepts both short id and full knowledge_entity:<id>', async () => {
    const facts = f.app.get(FactsService);
    const a = await facts.listCompeting(f.companyId, ENT_ID);
    const b = await facts.listCompeting(f.companyId, ENT_FULL);
    expect(a.groups.length).toBe(b.groups.length);
    expect(a.entityId).toBe(b.entityId);
  });
});
