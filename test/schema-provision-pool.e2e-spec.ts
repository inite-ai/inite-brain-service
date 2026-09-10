/**
 * Provisioning a cold tenant must not consume the connection pool.
 *
 * `withCompany` / `withScopedCompany` / `withAdminDb` used to acquire a
 * pooled connection and only then wait for `ensureSchema` — which runs on
 * the dedicated migrator connection, queues behind every other tenant on
 * this pod, and (since the cross-replica lease) can also wait for another
 * replica. So N concurrent first-requests parked N pool slots on work
 * that never touches them, and everything else on the process queued
 * behind an acquire timeout it had no way to influence. That is what took
 * out unrelated suites — `tool-observation`, `db-restart-recovery` — with
 * "Surreal root pool acquire timed out (pool=8, waiters=4)".
 *
 * The pool is deliberately tiny here and the acquire timeout short, so
 * the property is tested rather than the machine's speed: more cold
 * tenants at once than the pool has connections, all of them served.
 */
import { createApp, type AppFixture } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

const POOL_SIZE = 2;
const ACQUIRE_TIMEOUT_MS = 2000;
const COLD_TENANTS = 6;

describe('cold-tenant provisioning does not hold pool connections', () => {
  let f: AppFixture;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of [
      'SURREALDB_POOL_SIZE',
      'SURREALDB_SCOPED_POOL_SIZE',
      'SURREALDB_ACQUIRE_TIMEOUT_MS',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.SURREALDB_POOL_SIZE = String(POOL_SIZE);
    process.env.SURREALDB_SCOPED_POOL_SIZE = String(POOL_SIZE);
    process.env.SURREALDB_ACQUIRE_TIMEOUT_MS = String(ACQUIRE_TIMEOUT_MS);
    f = await createApp({ companyId: 'co_provision_pool_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('serves more concurrent cold tenants than the pool has connections', async () => {
    const surreal = f.app.get(SurrealService);
    const stamp = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: COLD_TENANTS }, (_, i) =>
        surreal.withCompany(`prov${stamp}x${i}`, async (db) => {
          await db.query('RETURN 1');
          return i;
        }),
      ),
    );
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String((r.reason as Error)?.message ?? r.reason));
    expect(failures).toEqual([]);
    expect(results).toHaveLength(COLD_TENANTS);
  }, 300_000);

  it('serves a warm tenant while cold ones are still provisioning', async () => {
    // The warm read needs nothing but a free connection. If provisioning
    // parks the pool, this is the request that 500s in production.
    const surreal = f.app.get(SurrealService);
    const stamp = Date.now();
    const cold = Promise.allSettled(
      Array.from({ length: COLD_TENANTS }, (_, i) =>
        surreal.withCompany(`warmside${stamp}x${i}`, async (db) => {
          await db.query('RETURN 1');
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 150));
    const warm = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>('RETURN { n: 1 }');
      return rows;
    });
    expect(warm).toBeDefined();
    const settled = await cold;
    expect(settled.filter((r) => r.status === 'rejected')).toEqual([]);
  }, 300_000);
});
