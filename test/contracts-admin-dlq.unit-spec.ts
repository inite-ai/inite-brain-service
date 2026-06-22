/**
 * Wire-contract drift guard for GET /v1/admin/dlq.
 */
import { DlqResponseSchema } from '../src/contracts/admin/dlq.schema';
import { AdminOpsController } from '../src/admin/admin-ops.controller';
import type { AdminService } from '../src/admin/admin.service';

function makeController(): AdminOpsController {
  const admin = {
    listDeadLetter: async () => [
      {
        companyId: 'tenant-a',
        id: 'dlq:1',
        reason: 'predicate_unknown',
        rejectedAt: new Date().toISOString(),
        payload: { subject: 'e:x', predicate: 'unknown', object: 'e:y' },
      },
    ],
  } as unknown as AdminService;
  const undef = undefined as unknown as never;
  return new AdminOpsController(admin, undef, undef);
}

describe('AdminOpsController.dlq() — wire contract', () => {
  it('matches DlqResponseSchema', async () => {
    const parsed = DlqResponseSchema.safeParse(await makeController().dlq());
    if (!parsed.success) {
      throw new Error(
        `dlq drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
