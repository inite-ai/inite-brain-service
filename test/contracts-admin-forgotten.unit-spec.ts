/**
 * Wire-contract drift guard for GET /v1/admin/forgotten.
 */
import { ForgottenResponseSchema } from '../src/contracts/admin/forgotten.schema';
import { AdminOpsController } from '../src/admin/admin-ops.controller';
import type { AdminService } from '../src/admin/admin.service';

function makeController(): AdminOpsController {
  const admin = {
    listForgotten: async () => [
      {
        companyId: 'tenant-a',
        entityIdHash: 'sha256:deadbeef',
        reason: 'dsar:user-request',
        forgottenAt: new Date().toISOString(),
        factsDeleted: 12,
        edgesDeleted: 3,
      },
    ],
  } as unknown as AdminService;
  const undef = undefined as unknown as never;
  return new AdminOpsController(admin, undef, undef);
}

describe('AdminOpsController.forgotten() — wire contract', () => {
  it('matches ForgottenResponseSchema', async () => {
    const parsed = ForgottenResponseSchema.safeParse(
      await makeController().forgotten(),
    );
    if (!parsed.success) {
      throw new Error(
        `forgotten drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
