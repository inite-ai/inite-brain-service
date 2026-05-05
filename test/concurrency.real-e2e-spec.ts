/**
 * Concurrency test: verifies tenant isolation under parallel load.
 *
 * Pre-fix, SurrealService held a single shared connection and switched its
 * `db.use({ namespace, database })` per request. Under concurrent traffic,
 * tenant A's query could land on tenant B's database because B's `use()`
 * ran between A's `use()` and A's query in the same connection.
 *
 * This test ingests one distinct record per tenant in parallel, then reads
 * each tenant back and verifies it sees only its own record. With the bug,
 * we'd see records bleed across tenants.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StringRecordId } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  isUniqueViolation,
  retryOnUniqueViolation,
  withTransaction,
} from '../src/db/surreal.service';

const TENANT_COUNT = 50;

describe('SurrealService — concurrent tenant isolation', () => {
  let moduleRef: TestingModule;
  let surreal: SurrealService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [SurrealService],
    }).compile();
    await moduleRef.init();
    surreal = moduleRef.get(SurrealService);
  }, 60_000);

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
  });

  it(`isolates ${TENANT_COUNT} parallel tenants writing+reading their own records`, async () => {
    const tenants = Array.from({ length: TENANT_COUNT }, (_, i) => `conc${i}`);

    // Each tenant writes one distinctive entity in parallel
    await Promise.all(
      tenants.map((t) =>
        surreal.withCompany(t, async (db) => {
          await db.query(
            `CREATE knowledge_entity SET type = 'customer', canonicalName = $name`,
            { name: `mark_${t}` },
          );
        }),
      ),
    );

    // Each tenant reads its own DB in parallel; expects only its own record
    const results = await Promise.all(
      tenants.map((t) =>
        surreal.withCompany(t, async (db) => {
          const [rows] = await db.query<[Array<{ canonicalName: string }>]>(
            `SELECT canonicalName FROM knowledge_entity`,
          );
          return { tenant: t, names: (rows ?? []).map((r) => r.canonicalName) };
        }),
      ),
    );

    for (const { tenant, names } of results) {
      expect(names).toEqual([`mark_${tenant}`]);
    }

    // Cleanup: drop each tenant DB so subsequent test runs don't accumulate
    await Promise.all(tenants.map((t) => surreal.dropCompanyDatabase(t)));
  }, 120_000);

  it('upserts entity by external_ref idempotently under contention (no duplicates)', async () => {
    const tenant = 'upsert_race';
    const FANOUT = 32;
    const SHARED_KEY = 'rentals__cust_42';

    // Fire FANOUT concurrent resolve-or-create attempts for the SAME externalRef.
    // With UNIQUE on entity_external_ref.key + tx + retry-on-conflict, exactly
    // one knowledge_entity should exist after the burst.
    const upsertOnce = (i: number) =>
      surreal.withCompany(tenant, (db) =>
        retryOnUniqueViolation(async () => {
          const [hits] = await db.query<[Array<{ id: unknown }>]>(
            `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
            { key: SHARED_KEY },
          );
          if ((hits as any[])?.[0]) return String((hits as any[])[0]);
          return await withTransaction(db, async () => {
            const [inside] = await db.query<[Array<{ id: unknown }>]>(
              `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
              { key: SHARED_KEY },
            );
            if ((inside as any[])?.[0]) return String((inside as any[])[0]);
            const created = await dbCreate<any>(db, 'knowledge_entity', {
              type: 'customer',
              canonicalName: `cust_42_attempt_${i}`,
              externalRefs: { [SHARED_KEY]: 'cust_42' },
            });
            const eid = String(created?.id);
            await db.query(
              `CREATE entity_external_ref CONTENT { key: $key, entity: $eid }`,
              { key: SHARED_KEY, eid: new StringRecordId(eid) },
            );
            return eid;
          });
        }),
      );

    const results = await Promise.all(
      Array.from({ length: FANOUT }, (_, i) => upsertOnce(i)),
    );

    // All attempts converge on the same id
    const unique = new Set(results);
    expect(unique.size).toBe(1);

    // And the database holds exactly one entity for that key
    const count = await surreal.withCompany(tenant, async (db) => {
      const [rows] = await db.query<[Array<{ count: number }>]>(
        `SELECT count() AS count FROM knowledge_entity GROUP ALL`,
      );
      return ((rows as any[])?.[0]?.count as number) ?? 0;
    });
    expect(count).toBe(1);

    await surreal.dropCompanyDatabase(tenant);
  }, 60_000);

  it('rejects duplicate edges via UNIQUE on (in,out,kind)', async () => {
    const tenant = 'edge_dup';
    const ids = await surreal.withCompany(tenant, async (db) => {
      const a = await dbCreate<any>(db, 'knowledge_entity', {
        type: 'customer',
        canonicalName: 'A',
      });
      const b = await dbCreate<any>(db, 'knowledge_entity', {
        type: 'customer',
        canonicalName: 'B',
      });
      return { a: String(a.id), b: String(b.id) };
    });

    await surreal.withCompany(tenant, async (db) => {
      await db.query(
        `RELATE $from->knowledge_edge->$to CONTENT { kind: 'identity_of', weight: 1.0, source: {} } RETURN AFTER`,
        { from: new StringRecordId(ids.a), to: new StringRecordId(ids.b) },
      );

      // Second insert with same (in,out,kind) must fail-fast
      let unique = false;
      try {
        await db.query(
          `RELATE $from->knowledge_edge->$to CONTENT { kind: 'identity_of', weight: 1.0, source: {} } RETURN AFTER`,
          { from: new StringRecordId(ids.a), to: new StringRecordId(ids.b) },
        );
      } catch (err) {
        unique = isUniqueViolation(err);
      }
      expect(unique).toBe(true);

      // Different kind on same pair is allowed
      await db.query(
        `RELATE $from->knowledge_edge->$to CONTENT { kind: 'mentioned_with', weight: 0.5, source: {} } RETURN AFTER`,
        { from: new StringRecordId(ids.a), to: new StringRecordId(ids.b) },
      );

      const [rows] = await db.query<[Array<{ count: number }>]>(
        `SELECT count() AS count FROM knowledge_edge GROUP ALL`,
      );
      const count = ((rows as any[])?.[0]?.count as number) ?? 0;
      expect(count).toBe(2);
    });

    await surreal.dropCompanyDatabase(tenant);
  }, 60_000);

  it('exhausts pool then drains waiters without losing requests', async () => {
    const stats0 = surreal.poolStats();
    expect(stats0.size).toBeGreaterThanOrEqual(1);

    // Fire 4× pool size requests against a single tenant; each acquires +
    // releases. Final count should match number of requests.
    const N = stats0.size * 4;
    const tenant = 'pool_drain';
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        surreal.withCompany(tenant, async (db) => {
          await db.query(
            `CREATE knowledge_entity SET type = 'customer', canonicalName = $n`,
            { n: `drain_${i}` },
          );
        }),
      ),
    );

    const count = await surreal.withCompany(tenant, async (db) => {
      const [rows] = await db.query<[Array<{ count: number }>]>(
        `SELECT count() AS count FROM knowledge_entity GROUP ALL`,
      );
      return (rows?.[0]?.count as number) ?? 0;
    });
    expect(count).toBe(N);

    const statsEnd = surreal.poolStats();
    expect(statsEnd.idle).toBe(stats0.size);
    expect(statsEnd.waiters).toBe(0);

    await surreal.dropCompanyDatabase(tenant);
  }, 60_000);
});
