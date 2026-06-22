/**
 * Wire-contract drift guard for GET /v1/admin/operator-actions.
 */
import { OperatorActionsResponseSchema } from '../src/contracts/admin/operator-actions.schema';
import { AdminOpsController } from '../src/admin/admin-ops.controller';
import type { OperatorActionService } from '../src/admin/operator-action.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

function makeController(): AdminOpsController {
  const actions = {
    list: async () => [
      {
        ts: new Date().toISOString(),
        actor: 'tenant-a',
        scopes: ['brain:admin'],
        method: 'POST',
        path: '/v1/admin/dreams/run',
        status: 202,
        durationMs: 42,
        query: null,
        bodySummary: { operations: ['dedup'] },
        companyId: 'tenant-a',
      },
    ],
  } as unknown as OperatorActionService;
  const undef = undefined as unknown as never;
  return new AdminOpsController(undef, undef, actions);
}

describe('AdminOpsController.operatorActions() — wire contract', () => {
  it('matches OperatorActionsResponseSchema', async () => {
    const controller = makeController();
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const payload = await controller.operatorActions(req);
    const parsed = OperatorActionsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `operator-actions drifted: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
  });
});
