import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobRunService } from './job-run.service';
import { LeaderLeaseService } from './leader-lease.service';
import { DistributedLeaseGuard } from '../common/distributed-lease.guard';

/**
 * JobsModule — exports the generic JobRunService used by every long-
 * running operator pipeline (dreams, compaction, calibration refit,
 * reindex, changefeed drain). Marked @Global so each consumer
 * (Dreams/Compaction/AI/Audit/Admin) can inject without importing the
 * module explicitly.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [JobRunService, LeaderLeaseService, DistributedLeaseGuard],
  exports: [JobRunService, LeaderLeaseService, DistributedLeaseGuard],
})
export class JobsModule {}
