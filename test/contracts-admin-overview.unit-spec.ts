/**
 * Wire-contract drift guard for GET /v1/admin/overview.
 * See contracts-admin-leases for the broader rationale.
 *
 * Also pins that the handler threads the caller request into the service,
 * where tenant scoping (own-only for a plain admin) is enforced.
 */
import { OverviewResponseSchema } from '../src/contracts/admin/overview.schema';
import { makeAdminController, adminReq } from './helpers/admin-controllers';
import type { AdminController } from '../src/admin/admin.controller';
import type { AdminService } from '../src/admin/admin.service';

function makeController(seen?: { req?: unknown }): AdminController {
  const admin = {
    buildOverview: async (req: unknown) => {
      if (seen) seen.req = req;
      return {
        generatedAt: new Date().toISOString(),
        health: { surrealdb: 'ok' as const },
        totals: {
          tenants: 2,
          entities: 100,
          factsActive: 1234,
          factsRetracted: 5,
          deadLetterLast24h: 1,
          forgottenLast24h: 0,
        },
        metrics: {
          ingestFactsTotal: 9000,
          ingestFactsByOutcome: { accepted: 9000 },
          searchCallsTotal: 42,
          dreamsRunsTotal: 7,
          dreamsEmittedByKind: { identity_link: 3 },
          retractsTotal: 0,
          forgetsTotal: 0,
          openaiCallsTotal: 0,
          openaiTokensTotal: 0,
        },
        tenants: [{ companyId: 'tenant-a', entities: 50, factsActive: 600, factsRetracted: 5 }],
        recentDeadLetter: [],
        recentForgotten: [],
      };
    },
  } as unknown as AdminService;
  return makeAdminController({ admin });
}

describe('AdminController.overview() — wire contract', () => {
  it('matches OverviewResponseSchema', async () => {
    const parsed = OverviewResponseSchema.safeParse(await makeController().overview(adminReq()));
    if (!parsed.success) {
      throw new Error(`overview drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });

  it('threads the caller request into the service (tenant scope enforced there)', async () => {
    const seen: { req?: unknown } = {};
    const r = adminReq();
    await makeController(seen).overview(r);
    expect(seen.req).toBe(r);
  });
});
