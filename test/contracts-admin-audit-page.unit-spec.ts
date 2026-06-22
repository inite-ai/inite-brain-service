/**
 * Wire-contract drift guard for GET /v1/admin/audit.
 */
import { AuditPageResponseSchema } from '../src/contracts/admin/audit-page.schema';
import { AdminController } from '../src/admin/admin.controller';
import type { AdminService } from '../src/admin/admin.service';

function makeController(): AdminController {
  const admin = {
    listAuditEvents: async () => ({
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
    }),
  } as unknown as AdminService;
  const undef = undefined as unknown as never;
   
  return new AdminController(
    admin, undef, undef, undef, undef, undef, undef, undef, undef, undef,
  );
}

describe('AdminController.audit() — wire contract', () => {
  it('matches AuditPageResponseSchema', async () => {
    const parsed = AuditPageResponseSchema.safeParse(
      await makeController().audit(),
    );
    if (!parsed.success) {
      throw new Error(
        `audit drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
