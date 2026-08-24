/**
 * Cross-tenant (company-level) scope pinning — the platform analogue of
 * pinUserScope() (per-user, user-scope.ts). Where pinUserScope keeps a
 * user-bound token inside one user's slice of a tenant, this keeps an
 * admin-scoped key inside its OWN tenant.
 *
 * The tenant target of an admin operation is caller-asserted (a `tenant`
 * body/query field, or the X-Brain-Tenant header). A `brain:admin`
 * credential holds authority over ITS tenant only — it must never reach
 * another registered tenant just because that tenant exists. Reaching a
 * DIFFERENT tenant is a distinct, higher capability: it requires BOTH
 *
 *   1. the dedicated `brain:platform_admin` scope on the credential, AND
 *   2. the BRAIN_TENANT_OVERRIDE_ENABLED env gate (default off).
 *
 * Both are required; either alone denies. With the gate off, or without
 * the platform scope, an admin caller can ONLY ever operate on
 * req.brainAuth.companyId — a `tenant` naming another company is a 403,
 * never silently honored (the tenant-isolation bypass this closes).
 *
 * Pure module — importable from controllers and the guard alike. Reads
 * the gate off process.env per call (runtime-mutable, matching the
 * catalog), via the sanctioned envFlagEnabled parser.
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { envFlagEnabled } from '../common/env-validation';
import type { AuthenticatedRequest, BrainScope } from './api-key.types';

/**
 * Cross-tenant is a separate capability from tenant-local `brain:admin`.
 * Granted per hosting-operator integration via env-key config — like
 * `registry:curate`, deliberately NOT part of the jwks VALID_SCOPES set
 * (never mintable through the normal token path).
 */
export const PLATFORM_TENANT_SCOPE: BrainScope = 'brain:platform_admin';

/** The env gate that unlocks the platform-operator cross-tenant path. */
export function tenantOverrideEnabled(): boolean {
  return envFlagEnabled(process.env.BRAIN_TENANT_OVERRIDE_ENABLED);
}

/**
 * True ONLY when this credential may address a tenant other than its own:
 * it carries the platform scope AND the gate is on. Both required.
 */
export function platformTenantCapable(scopes: readonly BrainScope[]): boolean {
  return tenantOverrideEnabled() && scopes.includes(PLATFORM_TENANT_SCOPE);
}

export interface ResolvePlatformTenantOptions {
  /**
   * Registered tenants — a foreign target must be one of these. Supplied
   * as a thunk so it is only evaluated on the (rare) sanctioned
   * cross-tenant path, never on the hot own-tenant path.
   */
  knownTenants?: () => readonly string[];
}

/**
 * Resolve the effective tenant for an admin request.
 *
 *  - No tenant requested, or the requested tenant equals the caller's own
 *    → the caller's own companyId (pre-existing behavior, byte-identical).
 *  - A DIFFERENT tenant requested → DENY (403 ForbiddenException) unless
 *    the caller is platform-capable (platform scope + gate). On the
 *    sanctioned path an unknown tenant is still a 400.
 *
 * This is the ONE place cross-tenant is decided; controllers must not
 * re-implement the check.
 */
export function resolvePlatformTenant(
  req: AuthenticatedRequest,
  requested: string | undefined,
  opts: ResolvePlatformTenantOptions = {},
): string {
  const own = req.brainAuth.companyId;
  const target = requested?.trim();
  if (!target || target === own) return own;

  // A different tenant is asked for: cross-tenant capability required.
  if (!platformTenantCapable(req.brainAuth.scopes)) {
    throw new ForbiddenException(
      'Cross-tenant access denied: addressing a tenant other than your own ' +
        'requires the brain:platform_admin scope and BRAIN_TENANT_OVERRIDE_ENABLED',
    );
  }

  const known = opts.knownTenants?.() ?? [];
  if (!known.includes(target)) {
    throw new BadRequestException(`Unknown tenant '${target}' — not a registered tenant`);
  }
  return target;
}

/**
 * The set of tenants an admin READ may span — the aggregate-read analogue
 * of resolvePlatformTenant. A plain brain:admin is confined to its own
 * tenant; a platform operator (scope + gate) spans every registered
 * tenant. An optional caller-supplied `requested` narrows to that single
 * tenant through resolvePlatformTenant (own ok; a foreign tenant is a 403
 * without the platform capability, then a 400 if unknown).
 *
 * Use this wherever a handler/service would otherwise fan a read out over
 * apiKeys.knownCompanyIds() and return the result to the caller, so a
 * plain admin never observes another tenant's data or activity.
 */
export function resolvePlatformTenantScope(
  req: AuthenticatedRequest,
  requested: string | undefined,
  opts: ResolvePlatformTenantOptions = {},
): readonly string[] {
  const target = requested?.trim();
  if (target) return [resolvePlatformTenant(req, target, opts)];
  return platformTenantCapable(req.brainAuth.scopes)
    ? (opts.knownTenants?.() ?? [req.brainAuth.companyId])
    : [req.brainAuth.companyId];
}
