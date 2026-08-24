/**
 * Wire-contract drift guard for GET /v1/admin/pii.
 *
 * Also pins that the handler threads the caller request into the service,
 * where tenant scoping (own-only for a plain admin) is enforced.
 */
import { PiiInventoryResponseSchema } from '../src/contracts/admin/pii.schema';
import { AdminOpsController } from '../src/admin/admin-ops.controller';
import { adminReq } from './helpers/admin-controllers';
import type { AdminService } from '../src/admin/admin.service';

function makeController(seen?: { req?: unknown }): AdminOpsController {
  const admin = {
    listPiiInventory: async (req: unknown) => {
      if (seen) seen.req = req;
      return [
        {
          companyId: 'tenant-a',
          predicate: 'has_email',
          piiClass: 'identifier',
          requiresScope: 'brain:read_pii',
          factCount: 42,
          retractedCount: 0,
        },
      ];
    },
  } as unknown as AdminService;
  const undef = undefined as unknown as never;
  return new AdminOpsController(admin, undef, undef);
}

describe('AdminOpsController.piiInventory() — wire contract', () => {
  it('matches PiiInventoryResponseSchema', async () => {
    const parsed = PiiInventoryResponseSchema.safeParse(
      await makeController().piiInventory(adminReq()),
    );
    if (!parsed.success) {
      throw new Error(`pii drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });

  it('threads the caller request into the service (tenant scope enforced there)', async () => {
    const seen: { req?: unknown } = {};
    const r = adminReq();
    await makeController(seen).piiInventory(r);
    expect(seen.req).toBe(r);
  });
});
