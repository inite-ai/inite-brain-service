import { createHash } from 'node:crypto';
import { Gauge, type Registry } from 'prom-client';
import { breakerStates } from '../ai/circuit-breaker';
import { budgetRefusals, tenantTokensToday, tenantsSeen } from '../ai/tenant-llm-budget';

/** Tenant label buckets: bounded cardinality, never a raw company id. */
const TENANT_BUCKETS = 16;

function tenantBucket(tenant: string): string {
  return String(createHash('sha256').update(tenant).digest().readUInt8(0) % TENANT_BUCKETS);
}

const STATE_VALUE = { closed: 0, half_open: 1, open: 2 } as const;

/**
 * The per-tenant model budget and the provider circuit breakers on /metrics
 * (#853): tokens charged today per tenant bucket, calls refused for a spent
 * budget, and each (provider, model) breaker's state.
 */
export function llmBudgetGauges(registry: Registry): void {
  new Gauge({
    name: 'brain_llm_tenant_tokens_today',
    help: 'Chat tokens charged to tenants today (UTC) as this replica knows them, by tenant hash bucket',
    labelNames: ['tenant_bucket'] as const,
    registers: [registry],
    collect() {
      this.reset();
      const sums = new Map<string, number>();
      for (const t of tenantsSeen()) {
        const b = tenantBucket(t);
        sums.set(b, (sums.get(b) ?? 0) + tenantTokensToday(t));
      }
      for (const [tenant_bucket, v] of sums) this.set({ tenant_bucket }, v);
    },
  });
  new Gauge({
    name: 'brain_llm_budget_refusals',
    help: 'Chat calls refused since boot because their tenant had spent its daily model budget',
    registers: [registry],
    collect() {
      this.set(budgetRefusals());
    },
  });
  new Gauge({
    name: 'brain_llm_breaker_state',
    help: 'Circuit breaker per model provider route: 0 closed, 1 half-open (probing), 2 open',
    labelNames: ['route'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const [route, b] of breakerStates()) this.set({ route }, STATE_VALUE[b.current()]);
    },
  });
}
