/**
 * Predicate consolidation against a LIVE SurrealDB.
 *
 * This file exists because of a bug a unit test could not have caught.
 * The alias backfill wrote `updatedAt = time::now()` onto knowledge_fact
 * — a SCHEMAFULL table with no such field — so every statement threw:
 *
 *   Found field 'updatedAt', but no such field exists for table 'knowledge_fact'
 *
 * It failed 66 times in one pass, swallowed by the method's own
 * best-effort catch, and the only reason it surfaced at all is that the
 * method reports a COUNT rather than returning void. A stubbed db in a
 * unit spec answers any statement happily; only a real schemafull table
 * says no. So the write half of this pass is pinned here.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { PredicateConsolidationService } from '../src/admin/predicate-consolidation.service';

describe('predicate consolidation — the writes, against a real schemafull table', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  let registry: PredicateRegistryService;
  let consolidation: PredicateConsolidationService;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_predcons_e2e' });
    surreal = f.app.get(SurrealService);
    registry = f.app.get(PredicateRegistryService);
    consolidation = f.app.get(PredicateConsolidationService);
    await registry.getSnapshot(f.companyId); // bootstrap the seed rows

    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`CREATE knowledge_entity:predcons_e2e CONTENT {
        canonicalName: 'ledger-sync', type: 'other', createdAt: time::now()
      }`);
      // Two values of one setting, both ACTIVE, written under two names —
      // the shape a tenant is actually in: `deploys_to` stamped with its
      // alias at coin time, `deploy_target` never aliased.
      for (const [id, predicate, object, day] of [
        ['pc_a', 'deploy_target', 'Fly.io', '2026-03-02'],
        ['pc_b', 'deploy_target', 'AWS ECS Fargate', '2026-03-25'],
      ] as const) {
        await db.query(
          `CREATE type::record('knowledge_fact', $id) CONTENT {
             entityId: knowledge_entity:predcons_e2e,
             predicate: $predicate, object: $object, confidence: 0.9,
             status: 'active', validFrom: type::datetime($day + 'T00:00:00Z'),
             recordedAt: time::now(),
             source: { recorder: 'predcons-e2e', vertical: 'engineering' }
           }`,
          { id, predicate, object, day },
        );
      }
    });
  }, 120_000);

  afterAll(async () => {
    await f?.close?.();
  });

  it('alias() re-points already-written facts — the statement the schema rejected', async () => {
    const { factsRepointed } = await registry.alias(f.companyId, 'deploy_target', 'deployed_to');
    expect(factsRepointed).toBe(2);

    const aliases = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ predicateAlias?: unknown }>]>(
        `SELECT predicateAlias FROM knowledge_fact WHERE predicate = 'deploy_target'`,
      );
      return (rows ?? []).map((r) => r.predicateAlias);
    });
    expect(aliases).toEqual(['deployed_to', 'deployed_to']);
  }, 60_000);

  it('a second alias() re-points nothing — only an EMPTY alias is filled', async () => {
    const { factsRepointed } = await registry.alias(f.companyId, 'deploy_target', 'deployed_to');
    expect(factsRepointed).toBe(0);
  }, 60_000);

  /**
   * The re-resolve half, driven through the SERVICE.
   *
   * The first version of this test wrote the supersede statement by hand
   * and asserted the table accepted it. It passed, and the statement the
   * service actually sends still failed in production:
   *
   *   Couldn't coerce value for field `validUntil`: expected
   *   `none | datetime` but found `'2026-03-25T14:15:00.000Z'`
   *
   * — because the service binds an ISO STRING and 3.x does not coerce one
   * into a `datetime` field, while the hand-written literal was wrapped
   * in `type::datetime()`. A test that rewrites the statement it is
   * meant to pin cannot catch that, so this one calls the method.
   */
  it('re-resolves a contested single_active slot — cold cache and all', async () => {
    // The slot is the ALIAS the tests above stamped — `(predicateAlias ??
    // predicate)` — so the policy that decides this slot is the CANON's.
    // Registered the way tenants actually hold it: PROPOSED, which is the
    // status every coined predicate has, and single_active.
    await registry.create(f.companyId, {
      predicateId: 'deployed_to',
      semantics: 'single_active',
      piiClass: 'none',
      status: 'proposed',
    });
    // create() ends in invalidate(), which is precisely the state
    // alias() leaves the cache in — so a pass that does not re-warm
    // reads `deploy_target` off SEED_PREDICATES, misses, and declines
    // the slot as append_only. Asserted here rather than assumed:
    (registry as unknown as { cache: Map<string, unknown> }).cache.delete(f.companyId);

    const result = {
      slotsContested: 0,
      slotsResolved: 0,
      factsRetired: 0,
    } as unknown as Record<string, number>;
    const out = await (
      consolidation as unknown as {
        reresolveSlots: (c: string, r: unknown) => Promise<Record<string, number>>;
      }
    ).reresolveSlots(f.companyId, result);

    expect(out.slotsResolved).toBe(1);
    expect(out.factsRetired).toBe(1);

    const rows = await surreal.withCompany(f.companyId, async (db) => {
      const [after] = await db.query<
        [
          Array<{
            object?: unknown;
            status?: unknown;
            supersededBy?: unknown;
            validUntil?: unknown;
          }>,
        ]
      >(`SELECT object, status, supersededBy, validUntil FROM knowledge_fact ORDER BY object`);
      return after ?? [];
    });
    const byObject = new Map(rows.map((r) => [String(r.object), r]));
    // The later validFrom wins; the earlier becomes history, stamped the
    // way fn::resolve_fact stamps it — validUntil set to the winner's
    // validFrom, which is the datetime the coercion rejected.
    expect(byObject.get('AWS ECS Fargate')!.status).toBe('active');
    const loser = byObject.get('Fly.io')!;
    expect(loser.status).toBe('superseded');
    expect(String(loser.supersededBy)).toContain('pc_b');
    expect(String(loser.validUntil)).toContain('2026-03-25');
  }, 60_000);

  it('is idempotent — a second pass finds one active value and stops', async () => {
    const out = await (
      consolidation as unknown as {
        reresolveSlots: (c: string, r: unknown) => Promise<Record<string, number>>;
      }
    ).reresolveSlots(f.companyId, {} as unknown);
    expect(out.slotsResolved).toBe(0);
    expect(out.factsRetired).toBe(0);
  }, 60_000);
});
