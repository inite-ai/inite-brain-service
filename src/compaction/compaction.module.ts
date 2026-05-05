import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CompactionService } from './compaction.service';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [ScheduleModule.forRoot(), MetricsModule],
  providers: [CompactionService],
  exports: [CompactionService],
})
export class CompactionModule {}
