/**
 * Wire-contract drift guard for GET /v1/admin/now.
 */
import { NowResponseSchema } from '../src/contracts/admin/now.schema';
import { makeAdminInfraController } from './helpers/admin-controllers';
import type { AdminInfraController } from '../src/admin/admin-infra.controller';
import type { ActivityTrackerService } from '../src/common/activity-tracker.service';

function makeController(): AdminInfraController {
  const activity = {
    list: () => [
      {
        id: 'req-1',
        method: 'GET',
        path: '/v1/search',
        companyId: 'tenant-a',
        startedAtMs: Date.now() - 200,
      },
      {
        id: 'req-2',
        method: 'POST',
        path: '/v1/ingest/fact',
        startedAtMs: Date.now() - 50,
      },
    ],
  } as unknown as ActivityTrackerService;
  return makeAdminInfraController({ activity });
}

describe('AdminInfraController.now() — wire contract', () => {
  it('matches NowResponseSchema', () => {
    const parsed = NowResponseSchema.safeParse(makeController().now());
    if (!parsed.success) {
      throw new Error(
        `now drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
