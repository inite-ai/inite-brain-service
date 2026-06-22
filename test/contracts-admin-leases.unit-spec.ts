/**
 * Wire-contract drift guard for GET /v1/admin/leases.
 *
 * The controller is `satisfies LeasesResponse` at the type level, which
 * is necessary but not sufficient — TypeScript doesn't catch shape
 * drift introduced through the spread on `...row` (when row carries
 * extra fields the schema doesn't declare, ts is fine; when row is
 * missing a field the schema requires, ts is also fine if the inferred
 * row type is broad enough). This test runs the controller against
 * mocked deps with realistic row payloads and feeds the result through
 * `LeasesResponseSchema.parse()`. If the runtime payload diverges from
 * the schema, this fails — and the BFF would 502 in production.
 */
import { LeasesResponseSchema } from '../src/contracts/admin/leases.schema';
import { AdminJobsController } from '../src/admin/admin-jobs.controller';
import type { ConfigService } from '@nestjs/config';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { JobClaimService } from '../src/jobs/job-claim.service';
import type { LeaderLeaseService } from '../src/jobs/leader-lease.service';
import type { WorkerLoopService } from '../src/jobs/worker-loop.service';
import type { JobWorkerPool } from '../src/jobs/job-worker-pool.service';

function makeController(): AdminJobsController {
  const claim = {
    identity: () => 'pod-1#42',
    listActiveClaims: async () => [
      {
        runId: 'run-abc',
        jobType: 'dreams',
        companyId: 'tenant-a',
        claimedBy: 'pod-1#42',
        claimedAt: new Date(Date.now() - 60_000).toISOString(),
        leaseUntil: new Date(Date.now() + 30_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
        attempts: 1,
      },
    ],
  } as unknown as JobClaimService;

  const leaderLease = {
    list: async () => [
      {
        name: 'worker_loop',
        leaderId: 'pod-1#42',
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      },
    ],
  } as unknown as LeaderLeaseService;

  const workerLoop = {
    leader: () => true,
    registeredTypes: () => ['dreams', 'compaction'],
  } as unknown as WorkerLoopService;

  const workerPool = {
    enabled: () => true,
    stats: () => ({ size: 4, idle: 3, busy: 1, waiters: 0 }),
  } as unknown as JobWorkerPool;

  const apiKeys = {
    knownCompanyIds: () => ['tenant-a', 'tenant-b'],
  } as unknown as ApiKeyService;

  const config = {
    get: <T>(_key: string, dflt?: T) => dflt,
  } as unknown as ConfigService;

  const undef = undefined as unknown as never;
   
  return new AdminJobsController(
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    apiKeys,
    undef,
    undef,
    claim,
    leaderLease,
    workerLoop,
    workerPool,
    undef,
    config,
  );
}

describe('AdminJobsController.leases() — wire contract', () => {
  it('matches LeasesResponseSchema', async () => {
    const controller = makeController();
    const payload = await controller.leases();
    const parsed = LeasesResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `controller drifted from LeasesResponseSchema: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
    expect(parsed.success).toBe(true);
  });

  it('handles empty leases/claims gracefully', async () => {
    const controller = new AdminJobsController(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { knownCompanyIds: () => [] } as unknown as ApiKeyService,
      undefined as never,
      undefined as never,
      {
        identity: () => 'pod-x#1',
        listActiveClaims: async () => [],
      } as unknown as JobClaimService,
      { list: async () => [] } as unknown as LeaderLeaseService,
      {
        leader: () => false,
        registeredTypes: () => [],
      } as unknown as WorkerLoopService,
      {
        enabled: () => false,
        stats: () => ({ size: 0, idle: 0, busy: 0, waiters: 0 }),
      } as unknown as JobWorkerPool,
      undefined as never,
      { get: () => 'inline' } as unknown as ConfigService,
    );
    const payload = await controller.leases();
    const parsed = LeasesResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.leaderLeases).toHaveLength(0);
      expect(parsed.data.activeClaims).toHaveLength(0);
      expect(parsed.data.queueMode).toBe('inline');
    }
  });
});
