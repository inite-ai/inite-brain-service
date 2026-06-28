/**
 * Wire-contract drift guard for GET /v1/admin/throttler.
 */
import { ThrottlerResponseSchema } from '../src/contracts/admin/throttler.schema';
import { makeAdminInfraController } from './helpers/admin-controllers';
import type { AdminInfraController } from '../src/admin/admin-infra.controller';
import { LiveSnapshotService } from '../src/admin/live-snapshot.service';
import type { ThrottlerObservabilityService } from '../src/admin/throttler-observability.service';
import type { ActivityTrackerService } from '../src/common/activity-tracker.service';

function makeController(): AdminInfraController {
  const throttler = {
    snapshot: () => ({
      topRoutes: [
        {
          route: 'POST /v1/synthesize',
          total: 100,
          throttled: 5,
          throttledRate: 0.05,
        },
      ],
      topActors: [
        { actor: 'tenant-a', total: 50, throttled: 1, throttledRate: 0.02 },
      ],
      recentThrottled: [
        {
          ts: new Date().toISOString(),
          actor: 'tenant-a',
          method: 'POST',
          path: '/v1/synthesize',
          bucket: 'expensive' as const,
        },
      ],
    }),
  } as unknown as ThrottlerObservabilityService;
  const liveSnapshot = new LiveSnapshotService(
    throttler,
    undefined as unknown as ActivityTrackerService,
  );
  return makeAdminInfraController({ liveSnapshot });
}

describe('AdminInfraController.throttlerView() — wire contract', () => {
  it('matches ThrottlerResponseSchema', () => {
    const parsed = ThrottlerResponseSchema.safeParse(
      makeController().throttlerView(),
    );
    if (!parsed.success) {
      throw new Error(
        `throttler drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
