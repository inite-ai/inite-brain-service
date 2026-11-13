import {
  DEMO_ORG_ID,
  DEMO_ORG_NAME,
  DEMO_ORG_SLUG,
  isDemoCompanyId,
} from '../src/demo/demo-tenant';
import { VALID_COMPANY_ID } from '../src/auth/claim-parsers';

/**
 * The demo tenant's ids are the family's (inite-auth-service
 * src/organizations/demo-tenant.ts, inite-shared @inite/auth/demo). This
 * repo is public and imports neither, so the value is pinned here: a drift
 * would point the demo workspace and the seed at a tenant nobody signs in to.
 * The landing's copy (brain-landing/lib/demo-tenant.ts) is checked against
 * this file by brain-landing/__tests__/demo-tenant.test.ts.
 */
describe('demo tenant pin', () => {
  it('is the family demo org', () => {
    expect(DEMO_ORG_ID).toBe('a7a71c00-de00-4000-8000-000000000001');
    expect(DEMO_ORG_SLUG).toBe('demo');
    expect(DEMO_ORG_NAME).toBe('Atlântica Group (demo)');
  });

  it('is a valid Brain companyId (the co_<id> database name)', () => {
    expect(VALID_COMPANY_ID.test(DEMO_ORG_ID)).toBe(true);
  });

  it('matches only itself', () => {
    expect(isDemoCompanyId(DEMO_ORG_ID)).toBe(true);
    expect(isDemoCompanyId('demo')).toBe(false);
    expect(isDemoCompanyId(`${DEMO_ORG_ID} `)).toBe(false);
    expect(isDemoCompanyId(undefined)).toBe(false);
  });
});
