/**
 * Wire-contract drift guard for GET /v1/admin/pii.
 */
import { PiiInventoryResponseSchema } from '../src/contracts/admin/pii.schema';
import { AdminOpsController } from '../src/admin/admin-ops.controller';
import type { AdminService } from '../src/admin/admin.service';

function makeController(): AdminOpsController {
  const admin = {
    listPiiInventory: async () => [
      {
        companyId: 'tenant-a',
        predicate: 'has_email',
        piiClass: 'identifier',
        requiresScope: 'brain:read_pii',
        factCount: 42,
        retractedCount: 0,
      },
    ],
  } as unknown as AdminService;
  const undef = undefined as unknown as never;
  return new AdminOpsController(admin, undef, undef);
}

describe('AdminOpsController.piiInventory() — wire contract', () => {
  it('matches PiiInventoryResponseSchema', async () => {
    const parsed = PiiInventoryResponseSchema.safeParse(
      await makeController().piiInventory(),
    );
    if (!parsed.success) {
      throw new Error(
        `pii drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
