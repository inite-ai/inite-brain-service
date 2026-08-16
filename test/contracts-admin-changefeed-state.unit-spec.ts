/**
 * Wire-contract drift guard for GET /v1/admin/changefeed/state.
 *
 * Mocks ChangefeedConsumerService.stats() + cursorState() and feeds
 * the controller output through ChangefeedStateResponseSchema. See
 * contracts-admin-leases for the broader rationale.
 *
 * Notably guards against the readonly-sources subtlety: the service
 * exposes `sources: readonly string[]` (the constant SOURCES), and
 * the controller spreads it into a plain array on its way out.
 * Without that spread `satisfies` would fail at compile; without the
 * schema we'd lose track of it again next refactor.
 */
import { ChangefeedStateResponseSchema } from '../src/contracts/admin/changefeed-state.schema';
import { AdminJobsController } from '../src/admin/admin-jobs.controller';
import type { ChangefeedConsumerService } from '../src/audit/changefeed-consumer.service';

function makeChangefeed(): ChangefeedConsumerService {
  const SOURCES = ['attribution', 'fact_state'] as const;
  return {
    stats: () => ({
      enabled: true,
      inFlight: false,
      lastTickAt: new Date().toISOString(),
      lastPendingRemaining: 0,
      totalConsumed: 1234,
      tickCount: 87,
      lastError: null,
      sources: SOURCES,
      perBatchLimit: 100,
    }),
    cursorState: async () => [
      { companyId: 'tenant-a', source: 'attribution', cursor: 999 },
      { companyId: 'tenant-a', source: 'fact_state', cursor: 1001 },
    ],
  } as unknown as ChangefeedConsumerService;
}

function makeController(
  changefeed: ChangefeedConsumerService,
): AdminJobsController {
  const undef = undefined as unknown as never;
  return new AdminJobsController(
    undef,
    undef,
    undef,
    changefeed,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
  );
}

describe('AdminJobsController.changefeedState() — wire contract', () => {
  it('matches ChangefeedStateResponseSchema', async () => {
    const controller = makeController(makeChangefeed());
    const payload = await controller.changefeedState();
    const parsed = ChangefeedStateResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `controller drifted from ChangefeedStateResponseSchema: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
    expect(parsed.data.stats.sources).toEqual(['attribution', 'fact_state']);
    expect(parsed.data.cursors).toHaveLength(2);
  });

  it('accepts null lastTickAt and lastError on a cold service', async () => {
    const cold = {
      stats: () => ({
        enabled: false,
        inFlight: false,
        lastTickAt: null,
        lastPendingRemaining: 0,
        totalConsumed: 0,
        tickCount: 0,
        lastError: null,
        sources: [] as readonly string[],
        perBatchLimit: 0,
      }),
      cursorState: async () => [],
    } as unknown as ChangefeedConsumerService;
    const controller = makeController(cold);
    const parsed = ChangefeedStateResponseSchema.safeParse(
      await controller.changefeedState(),
    );
    expect(parsed.success).toBe(true);
  });
});
