import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobRunService } from './job-run.service';
import { JobClaimService } from './job-claim.service';
import { LeaderLeaseService } from './leader-lease.service';
import { WorkerLoopService } from './worker-loop.service';
import { LeaseManagerService } from './lease-manager.service';
import { JobWorkerPool } from './job-worker-pool.service';
import { DistributedLeaseGuard } from '../common/distributed-lease.guard';

/**
 * JobsModule — generic job-execution surface for every long-running
 * operator pipeline (dreams, compaction, calibration refit, reindex,
 * changefeed drain).
 *
 *   JobRunService    — read-side: list / get / observe / cancel + the
 *                       legacy synchronous `start()` path that paths
 *                       not yet migrated to the queue still use.
 *   JobClaimService  — write-side CAS primitives on the same job_run
 *                       table: enqueue / claimNext / renew / complete /
 *                       fail / reapZombies. The worker loop and
 *                       lease-manager cron call this.
 *   LeaderLeaseService — global mutex via leader_lease (Phase J part 1).
 *   DistributedLeaseGuard — drop-in for InFlightGuard at cron sites.
 *
 * @Global so each consumer (Dreams/Compaction/AI/Audit/Admin) can
 * inject without importing the module explicitly.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [
    JobRunService,
    JobClaimService,
    LeaderLeaseService,
    WorkerLoopService,
    LeaseManagerService,
    JobWorkerPool,
    DistributedLeaseGuard,
  ],
  exports: [
    JobRunService,
    JobClaimService,
    LeaderLeaseService,
    WorkerLoopService,
    LeaseManagerService,
    JobWorkerPool,
    DistributedLeaseGuard,
  ],
})
export class JobsModule {}
