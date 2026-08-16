/**
 * Wire-contract drift guard for GET /v1/admin/scheduler.
 *
 * The original drift case from the audit: backend returns
 * { cron, intervals, timeouts } but the frontend's local type only
 * declared { cron }. This test runs the controller against a mocked
 * SchedulerRegistry and feeds the result through
 * SchedulerResponseSchema.safeParse. See contracts-admin-leases for
 * the broader rationale.
 */
import { SchedulerResponseSchema } from '../src/contracts/admin/scheduler.schema';
import { AdminJobsController } from '../src/admin/admin-jobs.controller';
import type { SchedulerRegistry } from '@nestjs/schedule';

function makeScheduler(): SchedulerRegistry {
  return {
    getCronJobs: () =>
      new Map<string, unknown>([
        [
          'DreamsService.runDaily',
          {
            cronTime: { source: '0 4 * * *' },
            lastDate: () => new Date('2026-06-22T04:00:00Z'),
            nextDate: () => new Date('2026-06-23T04:00:00Z'),
            running: true,
          },
        ],
      ]),
    getIntervals: () => ['JobRunService.zombieReap'],
    getTimeouts: () => [],
  } as unknown as SchedulerRegistry;
}

function makeController(scheduler: SchedulerRegistry): AdminJobsController {
  const undef = undefined as unknown as never;
  return new AdminJobsController(
    undef,
    undef,
    undef,
    undef,
    scheduler,
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

describe('AdminJobsController.scheduler_() — wire contract', () => {
  it('matches SchedulerResponseSchema with cron + intervals + timeouts', () => {
    const controller = makeController(makeScheduler());
    const payload = controller.scheduler_();
    const parsed = SchedulerResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `controller drifted from SchedulerResponseSchema: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
    expect(parsed.data.cron).toHaveLength(1);
    expect(parsed.data.intervals).toEqual(['JobRunService.zombieReap']);
    expect(parsed.data.timeouts).toEqual([]);
    // Regression guard for the original drift: the panel ignored these
    // two fields. If they vanish from the schema, the wire contract
    // would silently allow that — pin the names here.
    expect(parsed.data).toHaveProperty('intervals');
    expect(parsed.data).toHaveProperty('timeouts');
  });

  it('tolerates an empty registry', () => {
    const empty = {
      getCronJobs: () => new Map(),
      getIntervals: () => [],
      getTimeouts: () => [],
    } as unknown as SchedulerRegistry;
    const controller = makeController(empty);
    const parsed = SchedulerResponseSchema.safeParse(controller.scheduler_());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cron).toHaveLength(0);
    }
  });
});
