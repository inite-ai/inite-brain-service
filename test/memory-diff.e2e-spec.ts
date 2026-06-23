/**
 * MemoryDiffService — integration smoke
 *
 * Acceptance from the roadmap brief:
 *   Plant ingest 5 facts at T1, retract 1 + add 1 at T2, diff(T1, T2)
 *   shows 1 retract + 1 add.
 *
 * We compress the timeline by stamping recordedAt + retractedAt
 * directly via SurrealService — relying on wall-clock between
 * ingest/retract is flaky on a fast machine. The ingest path tests
 * already cover the wire shape; this spec covers the diff window math
 * end-to-end against a real database.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { MemoryDiffService } from '../src/diff/memory-diff.service';

const ENT = 'md_subj';
const ENT_FULL = `knowledge_entity:${ENT}`;
const ENT_BYSTANDER = 'md_bystander';
const ENT_BYSTANDER_FULL = `knowledge_entity:${ENT_BYSTANDER}`;

const T0 = new Date('2026-04-01T00:00:00Z');
const T1 = new Date('2026-04-10T00:00:00Z');
const T2 = new Date('2026-04-20T00:00:00Z');
const T3 = new Date('2026-04-30T00:00:00Z');

describe('MemoryDiffService.diff — window math', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_memdiff_e2e' });

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      // Two entities: target + bystander. Created at T0.
      await db.query(
        `CREATE type::thing('knowledge_entity', $eid) CONTENT {
            type: 'customer',
            canonicalName: 'Diff Target',
            externalRefs: { rent: 'md_subj' },
            createdAt: $t0
         }`,
        { eid: ENT, t0: T0 },
      );
      // Bystander created INSIDE the window — should appear in newEntities.
      await db.query(
        `CREATE type::thing('knowledge_entity', $eid) CONTENT {
            type: 'customer',
            canonicalName: 'Diff Bystander',
            externalRefs: { rent: 'md_bystander' },
            createdAt: $t2
         }`,
        { eid: ENT_BYSTANDER, t2: T2 },
      );

      // 5 facts at T1 on the target.
      for (let i = 1; i <= 5; i++) {
        await db.query(
          `CREATE type::thing('knowledge_fact', $rid) CONTENT {
              entityId: type::thing('knowledge_entity', $eid),
              predicate: 'tag',
              object: $obj,
              confidence: 0.9,
              validFrom: $vf,
              recordedAt: $ra,
              status: 'active',
              source: { vertical: 'rent' }
           }`,
          {
            rid: `md_t1_${i}`,
            eid: ENT,
            obj: `tag_${i}`,
            vf: T1,
            ra: T1,
          },
        );
      }

      // At T2: retract md_t1_1 (pure retract — no successor).
      await db.query(
        `UPDATE type::thing('knowledge_fact', 'md_t1_1') SET
            status = 'retracted',
            retractedAt = $t2,
            retractionReason = 'operator',
            retractedBy = 'system'`,
        { t2: T2 },
      );
      // At T2: add md_t2_new — net-new active fact on target.
      await db.query(
        `CREATE type::thing('knowledge_fact', $rid) CONTENT {
            entityId: type::thing('knowledge_entity', $eid),
            predicate: 'tag',
            object: 'tag_added_in_t2',
            confidence: 0.95,
            validFrom: $vf,
            recordedAt: $ra,
            status: 'active',
            source: { vertical: 'rent' }
         }`,
        {
          rid: 'md_t2_new',
          eid: ENT,
          vf: T2,
          ra: T2,
        },
      );
      // At T2: a superseded transition — md_t1_2 is replaced by md_t2_replacement.
      await db.query(
        `CREATE type::thing('knowledge_fact', $rid) CONTENT {
            entityId: type::thing('knowledge_entity', $eid),
            predicate: 'tier',
            object: 'platinum',
            confidence: 0.95,
            validFrom: $vf,
            recordedAt: $ra,
            status: 'active',
            source: { vertical: 'rent' }
         }`,
        {
          rid: 'md_t2_replacement',
          eid: ENT,
          vf: T2,
          ra: T2,
        },
      );
      await db.query(
        `UPDATE type::thing('knowledge_fact', 'md_t1_2') SET
            status = 'superseded',
            retractedAt = $t2,
            retractionReason = 'superseded',
            supersededBy = type::thing('knowledge_fact', 'md_t2_replacement')`,
        { t2: T2 },
      );
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('reports created + retracted + changed inside the window', async () => {
    const diff = f.app.get(MemoryDiffService);
    const out = await diff.diff(f.companyId, {
      from: T1.toISOString(),
      to: T3.toISOString(),
    });

    expect(out.from).toBe(T1.toISOString());
    expect(out.to).toBe(T3.toISOString());

    // Created = 5 T1 facts + md_t2_new + md_t2_replacement = 7
    // minus md_t1_2 which was superseded → counted as changed, not
    // double-counted as create.
    expect(out.createdFacts.map((f) => f.factId).sort()).toEqual(
      [
        'knowledge_fact:md_t1_1',
        'knowledge_fact:md_t1_3',
        'knowledge_fact:md_t1_4',
        'knowledge_fact:md_t1_5',
        'knowledge_fact:md_t2_new',
        'knowledge_fact:md_t2_replacement',
      ].sort(),
    );

    // Retracted (without successor) = md_t1_1.
    expect(out.retractedFacts.map((f) => f.factId)).toEqual([
      'knowledge_fact:md_t1_1',
    ]);

    // Changed = md_t1_2 → md_t2_replacement.
    expect(out.changedFacts).toHaveLength(1);
    const [changed] = out.changedFacts;
    expect(changed.factId).toBe('knowledge_fact:md_t1_2');
    expect(changed.replacedBy).toBe('knowledge_fact:md_t2_replacement');
    expect(changed.before.predicate).toBe('tag');
    expect(changed.before.object).toBe('tag_2');
    expect(changed.after).toBeDefined();
    expect(changed.after?.predicate).toBe('tier');
    expect(changed.after?.object).toBe('platinum');

    // newEntities = bystander created at T2.
    expect(out.newEntities.map((e) => e.entityId)).toContain(ENT_BYSTANDER_FULL);

    // Target entity was created at T0 → NOT in newEntities.
    expect(out.newEntities.map((e) => e.entityId)).not.toContain(ENT_FULL);
  });

  it('window before any activity returns empty buckets', async () => {
    const diff = f.app.get(MemoryDiffService);
    const out = await diff.diff(f.companyId, {
      from: new Date('2025-01-01T00:00:00Z').toISOString(),
      to: new Date('2025-12-31T00:00:00Z').toISOString(),
    });
    expect(out.createdFacts).toHaveLength(0);
    expect(out.retractedFacts).toHaveLength(0);
    expect(out.changedFacts).toHaveLength(0);
    expect(out.newEntities).toHaveLength(0);
  });

  it('rejects from >= to', async () => {
    const diff = f.app.get(MemoryDiffService);
    await expect(
      diff.diff(f.companyId, {
        from: T2.toISOString(),
        to: T1.toISOString(),
      }),
    ).rejects.toThrow(/strictly before/);
  });

  it('scopes by predicates: tier-only excludes tag activity', async () => {
    const diff = f.app.get(MemoryDiffService);
    const out = await diff.diff(f.companyId, {
      from: T1.toISOString(),
      to: T3.toISOString(),
      predicates: ['tier'],
    });
    expect(out.createdFacts.map((f) => f.factId)).toEqual([
      'knowledge_fact:md_t2_replacement',
    ]);
    expect(out.retractedFacts).toHaveLength(0);
    expect(out.changedFacts).toHaveLength(0);
  });
});
