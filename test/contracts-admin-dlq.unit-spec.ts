/**
 * Wire-contract drift guard for GET /v1/admin/dlq.
 *
 * Also pins that the handler threads the caller request into the service,
 * where tenant scoping (own-only for a plain admin) is enforced.
 */
import { DlqResponseSchema } from '../src/contracts/admin/dlq.schema';
import { AdminOpsController } from '../src/admin/admin-ops.controller';
import { adminReq } from './helpers/admin-controllers';
import type { AdminService } from '../src/admin/admin.service';

function makeController(seen?: { req?: unknown }): AdminOpsController {
  const admin = {
    listDeadLetter: async (_filter: unknown, req: unknown) => {
      if (seen) seen.req = req;
      return [
        {
          companyId: 'tenant-a',
          id: 'dlq:1',
          reason: 'predicate_unknown',
          rejectedAt: new Date().toISOString(),
          payload: { subject: 'e:x', predicate: 'unknown', object: 'e:y' },
        },
      ];
    },
  } as unknown as AdminService;
  const undef = undefined as unknown as never;
  return new AdminOpsController(admin, undef, undef);
}

describe('AdminOpsController.dlq() — wire contract', () => {
  it('matches DlqResponseSchema', async () => {
    const parsed = DlqResponseSchema.safeParse(await makeController().dlq(adminReq()));
    if (!parsed.success) {
      throw new Error(`dlq drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });

  it('threads the caller request into the service (tenant scope enforced there)', async () => {
    const seen: { req?: unknown } = {};
    const r = adminReq();
    await makeController(seen).dlq(r);
    expect(seen.req).toBe(r);
  });
});
