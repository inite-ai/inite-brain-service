/**
 * The per-tenant daily model budget (#853). One workspace's import or retry
 * storm used to be able to spend the whole key for everyone — on 2026-10-28
 * the CI key ran dry exactly so. Every chat call is charged to the tenant of
 * the work that made it (common/tenant-context.ts) at the one place all
 * clients pass through (llm-usage-ledger.ts `withUsageLedger`), and a
 * tenant past its day's tokens gets `TenantBudgetExceeded` instead of a
 * call: background reading waits, an answer is given from retrieval.
 *
 * Counted per replica in memory and flushed every minute to one row per
 * (tenant, UTC day) in the system database (TenantSpendFlushService), the
 * throttler-storage posture: each replica's view is the shared total it
 * last read plus what it spent since, so replicas converge within a flush
 * and a replica never needs a round trip to decide.
 *
 * LLM_TENANT_DAILY_TOKEN_BUDGET is a value, 0 = no budget (the default).
 * Harness mode spends nothing, so the budget never fires there.
 */

/** The configured daily token budget per tenant; 0 = off. Read at call time. */
export function tenantDailyTokenBudget(
  read: (key: string) => string | undefined = (key) => process.env[key],
): number {
  const n = Number.parseInt(read('LLM_TENANT_DAILY_TOKEN_BUDGET') ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The refusal a call past its tenant's budget gets — a "no model now", like harness mode. */
export class TenantBudgetExceeded extends Error {
  readonly status = 429;
  readonly code = 'tenant_budget_exceeded';
  constructor() {
    super("this workspace has spent today's model budget; model work resumes tomorrow (UTC)");
    this.name = 'TenantBudgetExceeded';
  }
}

interface Spend {
  /** UTC day the counters are for (YYYY-MM-DD). */
  day: string;
  /** The shared total across replicas, as of the last flush. */
  shared: number;
  /** Spent by this replica since the last flush. */
  pending: number;
}

const spend = new Map<string, Spend>();
let refusals = 0;

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function current(tenant: string, day: string): Spend {
  let s = spend.get(tenant);
  if (!s || s.day !== day) {
    s = { day, shared: 0, pending: 0 };
    spend.set(tenant, s);
  }
  return s;
}

/** Tokens the tenant has spent today, as far as this replica knows. */
export function tenantTokensToday(tenant: string, now: Date = new Date()): number {
  const s = current(tenant, utcDay(now));
  return s.shared + s.pending;
}

export function chargeTenant(tenant: string, tokens: number, now: Date = new Date()): void {
  if (!(tokens > 0)) return;
  current(tenant, utcDay(now)).pending += tokens;
}

/** Whether a new call for `tenant` must be refused. */
export function tenantOverBudget(
  tenant: string,
  budget: number = tenantDailyTokenBudget(),
  now: Date = new Date(),
): boolean {
  return budget > 0 && tenantTokensToday(tenant, now) >= budget;
}

export function noteBudgetRefusal(): void {
  refusals += 1;
}

export function budgetRefusals(): number {
  return refusals;
}

/** What this replica spent since its last flush, per tenant — and forget it as pending. */
export function takePendingSpend(): Array<{ tenant: string; day: string; tokens: number }> {
  const out: Array<{ tenant: string; day: string; tokens: number }> = [];
  for (const [tenant, s] of spend) {
    if (s.pending > 0) out.push({ tenant, day: s.day, tokens: s.pending });
    s.pending = 0;
  }
  return out;
}

/** Hand back spend whose flush failed, so the next flush carries it. */
export function restorePendingSpend(
  rows: ReadonlyArray<{ tenant: string; day: string; tokens: number }>,
): void {
  for (const r of rows) {
    const s = current(r.tenant, r.day);
    if (s.day === r.day) s.pending += r.tokens;
  }
}

/** The shared total a flush read back for (tenant, day). */
export function applySharedSpend(tenant: string, day: string, total: number): void {
  const s = current(tenant, day);
  if (s.day === day) s.shared = Math.max(0, total);
}

/** Tenants this replica has seen today — the ones whose shared total it refreshes. */
export function tenantsSeen(now: Date = new Date()): string[] {
  const day = utcDay(now);
  return [...spend].filter(([, s]) => s.day === day).map(([t]) => t);
}

/** Test seam. */
export function resetTenantSpend(): void {
  spend.clear();
  refusals = 0;
}
