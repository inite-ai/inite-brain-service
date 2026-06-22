/**
 * Wire-contract drift guard for GET /v1/admin/overview.
 * See contracts-admin-leases for the broader rationale.
 */
import { OverviewResponseSchema } from '../src/contracts/admin/overview.schema';
import { AdminController } from '../src/admin/admin.controller';
import type { AdminService } from '../src/admin/admin.service';

function makeController(): AdminController {
  const admin = {
    buildOverview: async () => ({
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
      tenants: [
        { companyId: 'tenant-a', entities: 50, factsActive: 600, factsRetracted: 5 },
      ],
      recentDeadLetter: [],
      recentForgotten: [],
    }),
  } as unknown as AdminService;
  const undef = undefined as unknown as never;
   
  return new AdminController(
    admin, undef, undef, undef, undef, undef, undef, undef, undef, undef,
  );
}

describe('AdminController.overview() — wire contract', () => {
  it('matches OverviewResponseSchema', async () => {
    const parsed = OverviewResponseSchema.safeParse(
      await makeController().overview(),
    );
    if (!parsed.success) {
      throw new Error(
        `overview drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
