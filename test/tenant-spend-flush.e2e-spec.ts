/**
 * Per-tenant model spend shared between replicas (#853): a flush adds this
 * replica's pending tokens to the tenant's row for the day in the system
 * database and reads the shared total back, so spend another replica wrote
 * counts against the budget here too.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { TenantSpendFlushService } from '../src/ai/tenant-spend-flush.service';
import {
  chargeTenant,
  resetTenantSpend,
  tenantOverBudget,
  tenantTokensToday,
  utcDay,
} from '../src/ai/tenant-llm-budget';

describe('tenant model spend flush (real SurrealDB)', () => {
  let f: AppFixture;
  const tenant = `co_spend_${Date.now()}`;
  const day = utcDay();
  const rowTokens = async (): Promise<number | undefined> => {
    const [rows] = await f.app
      .get(SurrealService)
      .withAdminDb((db) =>
        db.query<[Array<{ tokens: number }>]>(
          `SELECT tokens FROM type::record('llm_tenant_spend', $id)`,
          { id: `${tenant}:${day}` },
        ),
      );
    return rows?.[0]?.tokens;
  };

  beforeAll(async () => {
    f = await createApp();
    resetTenantSpend();
  });
  afterAll(async () => {
    await f.app
      .get(SurrealService)
      .withAdminDb((db) =>
        db.query(`DELETE type::record('llm_tenant_spend', $id)`, { id: `${tenant}:${day}` }),
      );
    resetTenantSpend();
    await f.close();
  });

  it('adds pending tokens to the day row and keeps the shared total as the view', async () => {
    chargeTenant(tenant, 400);
    await f.app.get(TenantSpendFlushService).flush();
    expect(await rowTokens()).toBe(400);
    expect(tenantTokensToday(tenant)).toBe(400);
    chargeTenant(tenant, 100);
    await f.app.get(TenantSpendFlushService).flush();
    expect(await rowTokens()).toBe(500);
    expect(tenantTokensToday(tenant)).toBe(500);
  });

  it('spend another replica flushed counts here after the next flush', async () => {
    // Another replica's flush, as it lands in the shared row.
    await f.app.get(SurrealService).withAdminDb((db) =>
      db.query(`UPDATE type::record('llm_tenant_spend', $id) SET tokens = tokens + 1500`, {
        id: `${tenant}:${day}`,
      }),
    );
    expect(tenantOverBudget(tenant, 1_000)).toBe(false);
    await f.app.get(TenantSpendFlushService).flush();
    expect(tenantTokensToday(tenant)).toBe(2_000);
    expect(tenantOverBudget(tenant, 1_000)).toBe(true);
  });
});
