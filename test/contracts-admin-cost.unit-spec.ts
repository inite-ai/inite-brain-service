/**
 * Wire-contract drift guard for GET /v1/admin/cost.
 */
import { CostResponseSchema } from '../src/contracts/admin/cost.schema';
import { AdminController } from '../src/admin/admin.controller';
import type { AdminService } from '../src/admin/admin.service';

function makeController(): AdminController {
  const admin = {
    buildCostBreakdown: async () => ({
      total: { usd: 12.5, tokens: 150_000, calls: 200 },
      perModel: [
        {
          key: 'gpt-4o-mini',
          calls: 150,
          promptTokens: 100_000,
          completionTokens: 30_000,
          totalTokens: 130_000,
          usd: 5.5,
        },
      ],
      perOperation: [
        {
          key: 'extractor',
          calls: 150,
          promptTokens: 100_000,
          completionTokens: 30_000,
          totalTokens: 130_000,
          usd: 5.5,
        },
      ],
      perTenant: [],
      pricing: {
        'gpt-4o-mini': { promptPerMTok: 0.15, completionPerMTok: 0.6 },
      },
      source: 'metrics' as const,
    }),
  } as unknown as AdminService;
  const undef = undefined as unknown as never;
   
  return new AdminController(
    admin, undef, undef, undef, undef, undef, undef, undef, undef, undef,
  );
}

describe('AdminController.cost() — wire contract', () => {
  it('matches CostResponseSchema', async () => {
    const parsed = CostResponseSchema.safeParse(await makeController().cost());
    if (!parsed.success) {
      throw new Error(
        `cost drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
