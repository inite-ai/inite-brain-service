/**
 * Wire-contract drift guard for GET /v1/admin/audit.
 *
 * Also pins that the handler threads the caller request into the service,
 * where tenant scoping (own-only for a plain admin) is enforced.
 */
import { AuditPageResponseSchema } from '../src/contracts/admin/audit-page.schema';
import { makeAdminController, adminReq } from './helpers/admin-controllers';
import type { AdminController } from '../src/admin/admin.controller';
import type { AdminService } from '../src/admin/admin.service';

function makeController(seen?: { req?: unknown }): AdminController {
  const admin = {
    listAuditEvents: async (_q: unknown, req: unknown) => {
      if (seen) seen.req = req;
      return {
        events: [
          {
            id: 'audit:abc',
            companyId: 'tenant-a',
            source: 'knowledge_fact',
            recordId: 'kf:xyz',
            op: 'create',
            ts: new Date().toISOString(),
            versionstamp: 42,
            before: null,
            after: { value: 'x' },
            consumedBy: 'pod-1',
          },
        ],
        totalsBySource: { knowledge_fact: 1 },
        totalsByOp: { create: 1 },
        hourly: [{ hour: '2026-06-22T15', count: 1 }],
      };
    },
  } as unknown as AdminService;
  return makeAdminController({ admin });
}

describe('AdminController.audit() — wire contract', () => {
  it('matches AuditPageResponseSchema', async () => {
    const parsed = AuditPageResponseSchema.safeParse(await makeController().audit(adminReq()));
    if (!parsed.success) {
      throw new Error(`audit drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });

  it('threads the caller request into the service (tenant scope enforced there)', async () => {
    const seen: { req?: unknown } = {};
    const r = adminReq();
    await makeController(seen).audit(r);
    expect(seen.req).toBe(r);
  });
});
