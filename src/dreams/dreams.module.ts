import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CompactionModule } from '../compaction/compaction.module';
import { CommunityModule } from '../communities/community.module';
import { AuthModule } from '../auth/auth.module';
import { EpisodesModule } from '../episodes/episodes.module';
import { DreamsService } from './dreams.service';
import { DreamsController } from './dreams.controller';
import { DreamsDedupService } from './dedup.service';
import { DreamsResolverService } from './resolver.service';
import { DreamsCorroborateService } from './corroborate.service';

/**
 * DreamsModule — the off-hours self-improvement pass for brain.
 * Cron-driven (04:00 UTC daily); manual trigger via POST /v1/dreams/run.
 *
 * AiModule is global so EmbedderService is auto-injected. CompactionModule
 * is imported so the summarize op can reuse compactCompany() — and so
 * the LlmSummaryGenerator can replace the default ConcatSummaryGenerator
 * via the SUMMARY_GENERATOR token (see compaction.module.ts).
 * EpisodesModule provides ReadPinService: dreams legs are fenced to the
 * tenant's live derived world (audit W2 #10 — a version-blind dreams run
 * mutated fact status across residual worlds while the pinned reader saw
 * none of the justification).
 */
@Module({
  imports: [
    ConfigModule,
    CompactionModule,
    CommunityModule,
    AuthModule,
    EpisodesModule,
  ],
  controllers: [DreamsController],
  providers: [
    DreamsService,
    DreamsDedupService,
    DreamsResolverService,
    DreamsCorroborateService,
  ],
  exports: [DreamsService],
})
export class DreamsModule {}
