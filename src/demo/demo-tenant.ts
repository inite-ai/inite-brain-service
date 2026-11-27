/**
 * The INITE family's one demo tenant, «Atlântica Group (demo)».
 *
 * Source of truth: inite-auth-service `src/organizations/demo-tenant.ts`
 * (the org auth.inite.ai issues demo personas for) and its mirror in
 * inite-shared `packages/auth/src/kit/demo.ts` (`DEMO_ORG_ID`). This repo
 * is public and takes no private package, so the ids are pinned here, once,
 * and `test/demo-tenant.unit-spec.ts` fails if they drift.
 *
 * In Brain a tenant is the database `co_<companyId>`, and a user-bound
 * token's companyId is its `org` claim (src/auth/claim-parsers.ts), so the
 * demo tenant is `co_a7a71c00-de00-4000-8000-000000000001`. The demo
 * workspace reads only this tenant and the demo seed writes only to it.
 */
export const DEMO_ORG_ID = 'a7a71c00-de00-4000-8000-000000000001';
export const DEMO_ORG_SLUG = 'demo';
export const DEMO_ORG_NAME = 'Atlântica Group (demo)';

/** Is this companyId the demo tenant? Exact match, nothing else. */
export function isDemoCompanyId(companyId: string | null | undefined): boolean {
  return companyId === DEMO_ORG_ID;
}
