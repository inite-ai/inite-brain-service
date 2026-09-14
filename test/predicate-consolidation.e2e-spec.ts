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

describe('predicate consolidation — the writes, against a real schemafull table', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  let registry: PredicateRegistryService;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_predcons_e2e' });
    surreal = f.app.get(SurrealService);
    registry = f.app.get(PredicateRegistryService);
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

  it('the re-resolve stamp is a statement knowledge_fact accepts', async () => {
    // Every field here comes from fn::resolve_fact's own supersede write,
    // so a retroactively resolved fact is indistinguishable from one
    // resolved at ingest — and, like the backfill, it is only a real
    // schemafull table that can confirm the statement is legal.
    const updated = await surreal.withCompany(f.companyId, async (db) => {
      const [ids] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM knowledge_fact
          WHERE predicate = 'deploy_target' AND object = 'Fly.io'`,
      );
      await db.query(
        `UPDATE $ids SET
           status = 'superseded', retractedAt = time::now(),
           retractionReason = 'superseded', retractedBy = 'system',
           supersededBy = type::record('knowledge_fact', 'pc_b'),
           validUntil = type::datetime('2026-03-25T00:00:00Z')`,
        { ids: ids ?? [] },
      );
      const [after] = await db.query<[Array<{ status?: unknown; supersededBy?: unknown }>]>(
        `SELECT status, supersededBy FROM knowledge_fact WHERE object = 'Fly.io'`,
      );
      return after ?? [];
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]!.status).toBe('superseded');
    expect(String(updated[0]!.supersededBy)).toContain('pc_b');
  }, 60_000);
});
