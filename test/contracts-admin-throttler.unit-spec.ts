/**
 * Wire-contract drift guard for GET /v1/admin/throttler.
 */
import { ThrottlerResponseSchema } from '../src/contracts/admin/throttler.schema';
import { AdminInfraController } from '../src/admin/admin-infra.controller';
import type { ThrottlerObservabilityService } from '../src/admin/throttler-observability.service';

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
  const undef = undefined as unknown as never;
  return new AdminInfraController(
    undef,
    undef,
    undef,
    undef,
    undef,
    throttler,
    undef,
  );
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
