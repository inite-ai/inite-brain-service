/**
 * Model source per tenant (#945, phase 2): who pays for a tenant's
 * server-side chat calls.
 *
 *  - `platform` — the server calls its own models, billed to the operator.
 *    Only for a tenant that holds a paid entitlement (the comma list in
 *    MODEL_PLATFORM_ENTITLEMENTS, default `plan:pro,plan:team`).
 *  - `harness` — the server calls no model; the tenant's connected agent
 *    takes the reading through take_memory_work / submit_memory_work.
 *    Either the whole server (EXTRACTION_SOURCE=harness) or one tenant's
 *    own setting (`modelSource: 'harness'`).
 *  - `not_included` — a free tenant that did not choose harness: every
 *    server-side chat call is refused before the network, and its work
 *    still waits for its agent in the harness queue, so the agent gets the
 *    whole product.
 *  - `byok` — the tenant's own provider key. Reserved; not resolved yet.
 *
 * Rollout: MODEL_PLATFORM_GATE=observe (default) refuses nothing and
 * counts what it would refuse; `enforce` turns the refusal on. The operator
 * grants `platform` to server-to-server tenants first (see platformGateMode).
 *
 * Where entitlements come from: the verified user credential of every
 * request (`entitlements` claim), persisted on the tenant's registry row
 * (migration 0199) so background passes — which have no request — read
 * the same answer. A tenant the server has never seen a user credential
 * for has no record and resolves as free: free accounts must never spend
 * platform credits. An operator who serves every tenant from its own key
 * (self-hosting, static API keys) sets MODEL_PLATFORM_ENTITLEMENTS=*.
 *
 * Work outside any tenant (boot, process-wide passes) is not gated here:
 * only the server-wide EXTRACTION_SOURCE applies to it.
 *
 * Embeddings are never gated: the in-process bge-m3 has no bill (#947).
 */
import { Logger } from '@nestjs/common';
import { extractionSource, HarnessModeRefusal } from './extraction-source';
import { currentTenant } from './tenant-context';

export type ModelSource = 'platform' | 'harness' | 'byok' | 'not_included';

/**
 * A tenant's setting: `auto` = platform if entitled, else not included;
 * `harness` = its agent does the reading (the tenant's own choice);
 * `platform` = platform models regardless of entitlements — the operator's
 * override (brain:platform_admin) for server-to-server tenants whose M2M
 * credential carries no plan and that have no agent to do the reading.
 */
export type TenantModelSetting = 'auto' | 'harness' | 'platform';
export const TENANT_MODEL_SETTINGS: readonly TenantModelSetting[] = ['auto', 'harness', 'platform'];

/**
 * Rollout of the plan gate. `observe` (default): nothing is refused; a call
 * the gate would refuse is counted and logged once per tenant, so the
 * operator sees who would be cut off and grants `platform` before flipping
 * to `enforce`. `enforce`: a tenant without a paid plan is refused.
 */
export type PlatformGateMode = 'observe' | 'enforce';

export function platformGateMode(env: NodeJS.ProcessEnv = process.env): PlatformGateMode {
  return env.MODEL_PLATFORM_GATE?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'observe';
}

export type ModelSourceReason =
  | 'server_harness'
  | 'tenant_harness'
  | 'operator_platform'
  | 'gate_observe'
  | 'entitled'
  | 'not_entitled'
  | 'unknown_tenant'
  | 'no_tenant';

export interface ModelSourceResolution {
  source: ModelSource;
  reason: ModelSourceReason;
}

export const DEFAULT_PLATFORM_ENTITLEMENTS = 'plan:pro,plan:team';

interface TenantModelState {
  /** Last seen entitlements from a verified user credential; undefined = never seen. */
  entitlements?: readonly string[];
  setting?: TenantModelSetting;
}

const tenants = new Map<string, TenantModelState>();
const logger = new Logger('ModelSource');

/** The paid set; `*` means every tenant may use platform models. */
export function platformEntitlements(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.MODEL_PLATFORM_ENTITLEMENTS ?? DEFAULT_PLATFORM_ENTITLEMENTS;
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Record what a verified credential or a registry read says about a tenant. */
export function noteTenantModelState(companyId: string, patch: TenantModelState): void {
  const prev = tenants.get(companyId) ?? {};
  tenants.set(companyId, { ...prev, ...patch });
}

export function tenantModelState(companyId: string): Readonly<TenantModelState> | undefined {
  return tenants.get(companyId);
}

/** True when `next` differs from the entitlements this process last recorded. */
export function entitlementsChanged(companyId: string, next: readonly string[]): boolean {
  const prev = tenants.get(companyId)?.entitlements;
  if (!prev || prev.length !== next.length) return true;
  const a = [...prev].sort();
  return [...next].sort().some((e, i) => e !== a[i]);
}

/** Test seam: forget every tenant. */
export function resetTenantModelState(): void {
  tenants.clear();
  observed.clear();
}

/** Which source serves this tenant's server-side chat calls, and why. */
export function resolveModelSource(
  companyId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ModelSourceResolution {
  if (extractionSource(env) === 'harness') return { source: 'harness', reason: 'server_harness' };
  if (!companyId) return { source: 'platform', reason: 'no_tenant' };
  const state = tenants.get(companyId);
  if (state?.setting === 'harness') return { source: 'harness', reason: 'tenant_harness' };
  if (state?.setting === 'platform') return { source: 'platform', reason: 'operator_platform' };
  const paid = platformEntitlements(env);
  if (paid.has('*') || state?.entitlements?.some((e) => paid.has(e))) {
    return { source: 'platform', reason: 'entitled' };
  }
  if (platformGateMode(env) === 'observe') return { source: 'platform', reason: 'gate_observe' };
  return {
    source: 'not_included',
    reason: state?.entitlements ? 'not_entitled' : 'unknown_tenant',
  };
}

const observed = new Map<string, number>();

/** Calls the gate would have refused per tenant while in `observe` (status, tests). */
export function observedRefusals(companyId: string): number {
  return observed.get(companyId) ?? 0;
}

function noteObserved(companyId: string | undefined): void {
  if (!companyId) return;
  const n = (observed.get(companyId) ?? 0) + 1;
  observed.set(companyId, n);
  if (n === 1) {
    logger.warn(
      `model gate (observe): tenant ${companyId} has no platform plan; its chat calls would be refused under MODEL_PLATFORM_GATE=enforce`,
    );
  }
}

/** The current tenant's (from tenant context) resolution. */
export function currentModelSource(env: NodeJS.ProcessEnv = process.env): ModelSourceResolution {
  return resolveModelSource(currentTenant(), env);
}

/**
 * A free tenant's chat call, refused before the network. A subclass of
 * HarnessModeRefusal so every caller that already survives harness mode
 * (defer to the agent, keep the evidence) treats it the same way.
 */
export class PlatformModelsNotIncluded extends HarnessModeRefusal {
  override readonly code: string = 'platform_models_not_included';
  constructor() {
    super();
    this.message =
      'platform models not included: this plan does not include server-side models; the connected agent reads and answers';
    this.name = 'PlatformModelsNotIncluded';
  }
}

/** The refusal a chat call gets right now, or null when it may go out. */
export function serverModelRefusal(
  env: NodeJS.ProcessEnv = process.env,
): HarnessModeRefusal | null {
  const tenant = currentTenant();
  const { source, reason } = resolveModelSource(tenant, env);
  if (reason === 'gate_observe') noteObserved(tenant);
  if (source === 'harness') return new HarnessModeRefusal();
  if (source === 'not_included') return new PlatformModelsNotIncluded();
  return null;
}

/**
 * True when this tenant's background reading belongs in the harness queue
 * for its connected agent — harness mode, or a plan without platform models.
 */
export function harnessServesTenant(
  companyId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveModelSource(companyId, env).source !== 'platform';
}

/**
 * True when the server may not call a chat model for the current tenant:
 * server-wide harness mode, the tenant's own harness setting, or a plan
 * without platform models. Outside any tenant, only EXTRACTION_SOURCE.
 */
export function serverModelsRefused(env: NodeJS.ProcessEnv = process.env): boolean {
  return currentModelSource(env).source !== 'platform';
}
