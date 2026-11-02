/**
 * The per-tenant daily model budget (#853, ai/tenant-llm-budget.ts) and its
 * gate in the SDK ledger: a tenant past its tokens gets TenantBudgetExceeded
 * before any call, other tenants are untouched, a new UTC day starts fresh,
 * and the replica view converges on the shared total a flush reads back.
 */
import {
  TenantBudgetExceeded,
  applySharedSpend,
  chargeTenant,
  resetTenantSpend,
  restorePendingSpend,
  takePendingSpend,
  tenantDailyTokenBudget,
  tenantOverBudget,
  tenantTokensToday,
  utcDay,
} from '../src/ai/tenant-llm-budget';
import { resetLlmUsage, withUsageLedger } from '../src/ai/llm-usage-ledger';
import { runWithTenant } from '../src/common/tenant-context';

const DAY1 = new Date('2026-11-01T10:00:00Z');
const DAY2 = new Date('2026-11-02T00:00:01Z');

function fakeClient() {
  const create = jest.fn(async () => ({ usage: { prompt_tokens: 600, completion_tokens: 400 } }));
  return {
    create,
    client: {
      chat: { completions: { create } },
      embeddings: { create: jest.fn(async () => ({})) },
    },
  };
}

describe('tenant model budget', () => {
  beforeEach(() => {
    resetTenantSpend();
    resetLlmUsage();
  });

  it('reads the budget as a value; 0, unset or garbage mean none', () => {
    expect(tenantDailyTokenBudget(() => undefined)).toBe(0);
    expect(tenantDailyTokenBudget(() => '0')).toBe(0);
    expect(tenantDailyTokenBudget(() => 'lots')).toBe(0);
    expect(tenantDailyTokenBudget(() => '50000')).toBe(50_000);
  });

  it('counts per tenant and per UTC day', () => {
    chargeTenant('a', 700, DAY1);
    chargeTenant('b', 100, DAY1);
    expect(tenantTokensToday('a', DAY1)).toBe(700);
    expect(tenantOverBudget('a', 700, DAY1)).toBe(true);
    expect(tenantOverBudget('b', 700, DAY1)).toBe(false);
    // A new day starts from zero.
    expect(tenantOverBudget('a', 700, DAY2)).toBe(false);
    expect(utcDay(DAY2)).toBe('2026-11-02');
  });

  it('a budget of 0 never refuses', () => {
    chargeTenant('a', 10_000_000, DAY1);
    expect(tenantOverBudget('a', 0, DAY1)).toBe(false);
  });

  it('the replica view is the shared total plus what it spent since', () => {
    chargeTenant('a', 300, DAY1);
    const pending = takePendingSpend();
    expect(pending).toEqual([{ tenant: 'a', day: '2026-11-01', tokens: 300 }]);
    // Another replica spent 900 too; the flush reads the sum back.
    applySharedSpend('a', '2026-11-01', 1_200);
    chargeTenant('a', 50, DAY1);
    expect(tenantTokensToday('a', DAY1)).toBe(1_250);
    expect(takePendingSpend()).toEqual([{ tenant: 'a', day: '2026-11-01', tokens: 50 }]);
  });

  it('a failed flush hands its tokens back to the next one', () => {
    chargeTenant('a', 300, DAY1);
    const pending = takePendingSpend();
    restorePendingSpend(pending);
    expect(takePendingSpend()).toEqual(pending);
  });

  it('the ledger refuses a chat call for a tenant past its budget, before the network', async () => {
    const { client, create } = fakeClient();
    withUsageLedger(client, () => 1_000);
    const chat = client.chat.completions as unknown as { create: (b: unknown) => Promise<unknown> };
    await runWithTenant('co_heavy', () => chat.create({ model: 'm' }));
    expect(tenantTokensToday('co_heavy')).toBe(1_000);
    await expect(
      runWithTenant('co_heavy', () => chat.create({ model: 'm' })),
    ).rejects.toBeInstanceOf(TenantBudgetExceeded);
    expect(create).toHaveBeenCalledTimes(1);
    // Another tenant is untouched.
    await runWithTenant('co_light', () => chat.create({ model: 'm' }));
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('work with no tenant (boot, cross-tenant sweeps) is never refused', async () => {
    const { client, create } = fakeClient();
    withUsageLedger(client, () => 1);
    const chat = client.chat.completions as unknown as { create: (b: unknown) => Promise<unknown> };
    await chat.create({ model: 'm' });
    await chat.create({ model: 'm' });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
