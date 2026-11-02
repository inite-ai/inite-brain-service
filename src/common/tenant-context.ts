import { AsyncLocalStorage } from 'node:async_hooks';
import { getRequestContext } from './request-context';

/**
 * The tenant a piece of work runs for, without threading it through every
 * signature — what the per-tenant model budget (ai/tenant-llm-budget.ts)
 * charges a call to.
 *
 * Two sources, the narrower first: a scope opened by `runWithTenant`
 * (SurrealService.withCompany / withScopedCompany, the job dispatcher), then
 * the guarded request's own tenant. AsyncLocalStorage scopes nest and
 * restore, so work for one tenant inside another's scope is charged to the
 * inner one and never leaks back out; two concurrent tenants each read their
 * own (test/tenant-context.unit-spec.ts).
 */
const scope = new AsyncLocalStorage<string>();

export function runWithTenant<T>(companyId: string, fn: () => T): T {
  return scope.run(companyId, fn);
}

/** The tenant of the running work, or undefined (boot, cross-tenant sweeps). */
export function currentTenant(): string | undefined {
  return scope.getStore() ?? getRequestContext()?.companyId;
}
