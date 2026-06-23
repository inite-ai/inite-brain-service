import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { CompactionModule } from '../compaction/compaction.module';
import { CommunityModule } from '../communities/community.module';
import { AuthModule } from '../auth/auth.module';
import { DreamsService } from './dreams.service';
import { DreamsController } from './dreams.controller';
import { DreamsDedupService } from './dedup.service';
import { DreamsResolverService } from './resolver.service';

/**
 * DreamsModule — the off-hours self-improvement pass for brain.
 * Cron-driven (04:00 UTC daily); manual trigger via POST /v1/dreams/run.
 *
 * AiModule is global so EmbedderService is auto-injected. CompactionModule
 * is imported so the summarize op can reuse compactCompany() — and so
 * the LlmSummaryGenerator can replace the default ConcatSummaryGenerator
 * via the SUMMARY_GENERATOR token (see compaction.module.ts).
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule,
    CompactionModule,
    CommunityModule,
    AuthModule,
  ],
  controllers: [DreamsController],
  providers: [DreamsService, DreamsDedupService, DreamsResolverService],
  exports: [DreamsService],
})
export class DreamsModule {}
