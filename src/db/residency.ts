import { HttpException } from '@nestjs/common';

/**
 * Data residency (#916 step 3): a tenant's memory lives — and is processed
 * — in ONE region, and no deployment outside it creates or reads it.
 *
 * WHY. Russia's 152-FZ (tightened 2025-07-01) requires the primary
 * database of Russian citizens' data to be in Russia, with no copy held
 * abroad; other regimes ask the same of some customers. Routing one
 * process to several regional clusters would still move a tenant's turns
 * through a server abroad, which is itself a transfer. So residency is a
 * CELL: one brain deployment per region (its own SurrealDB, blob store
 * and model endpoint — all per-deployment config already), and each
 * deployment knows which region it is (BRAIN_REGION) and which region each
 * tenant it has been told about belongs to (`tenant_residency`, in the
 * deployment's system database — a directory of company ids, no personal
 * data).
 *
 * THE RULE, applied before a tenant's database is created or opened
 * (SurrealService.withCompany / withScopedCompany):
 *  - a tenant pinned to this deployment's region is served;
 *  - a tenant pinned to another region is refused with 421 Misdirected
 *    Request, its body naming the region — never created here, never
 *    read here;
 *  - a tenant with no pin is served only by the default deployment (no
 *    BRAIN_REGION): a regional cell serves only tenants assigned to it,
 *    so a misrouted first request cannot silently start a tenant abroad.
 * A deployment without BRAIN_REGION and with no pins behaves exactly as
 * before.
 */
export const DEFAULT_REGION = 'default';

/** Region names: lowercase, like `ru`, `eu-west`, `br`. */
export const REGION_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function deploymentRegion(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BRAIN_REGION?.trim().toLowerCase();
  if (!raw) return DEFAULT_REGION;
  if (!REGION_RE.test(raw)) throw new Error(`BRAIN_REGION "${raw}" is not a region name`);
  return raw;
}

export type ResidencyDecision = { serve: true } | { serve: false; region: string | null };

/** Whether this deployment serves the tenant, given its pin (null = none). */
export function residencyDecision(pin: string | null, here: string): ResidencyDecision {
  if (pin === null)
    return here === DEFAULT_REGION ? { serve: true } : { serve: false, region: null };
  return pin === here ? { serve: true } : { serve: false, region: pin };
}

/**
 * 421 Misdirected Request: this deployment does not serve the tenant. The
 * body's `region` (when known) tells the client where it is served;
 * the body says nothing about the tenant beyond that.
 */
export class MisdirectedTenantError extends HttpException {
  constructor(readonly region: string | null) {
    super(
      {
        statusCode: 421,
        error: 'Misdirected Request',
        message: region
          ? `this workspace is served in region "${region}"`
          : 'this workspace is not served by this deployment',
        ...(region ? { region } : {}),
      },
      421,
    );
  }
}
