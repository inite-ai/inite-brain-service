/**
 * Wire-contract drift guard for GET /v1/admin/forgotten.
 *
 * Also pins that the handler threads the caller request into the service,
 * where tenant scoping (own-only for a plain admin) is enforced.
 */
import { ForgottenResponseSchema } from '../src/contracts/admin/forgotten.schema';
import { AdminOpsController } from '../src/admin/admin-ops.controller';
import { adminReq } from './helpers/admin-controllers';
import type { AdminService } from '../src/admin/admin.service';

function makeController(seen?: { req?: unknown }): AdminOpsController {
  const admin = {
    listForgotten: async (_filter: unknown, req: unknown) => {
      if (seen) seen.req = req;
      return [
        {
          companyId: 'tenant-a',
          entityIdHash: 'sha256:deadbeef',
          reason: 'dsar:user-request',
          forgottenAt: new Date().toISOString(),
          factsDeleted: 12,
          edgesDeleted: 3,
        },
      ];
    },
  } as unknown as AdminService;
  const undef = undefined as unknown as never;
  return new AdminOpsController(admin, undef, undef);
}

describe('AdminOpsController.forgotten() — wire contract', () => {
  it('matches ForgottenResponseSchema', async () => {
    const parsed = ForgottenResponseSchema.safeParse(await makeController().forgotten(adminReq()));
    if (!parsed.success) {
      throw new Error(`forgotten drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });

  it('threads the caller request into the service (tenant scope enforced there)', async () => {
    const seen: { req?: unknown } = {};
    const r = adminReq();
    await makeController(seen).forgotten(r);
    expect(seen.req).toBe(r);
  });
});
