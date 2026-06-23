import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CompactionModule } from '../compaction/compaction.module';
import { CommunityBuilderService } from './community-builder.service';
import { CommunityService } from './community.service';

/**
 * CommunityModule — topic clustering of the entity graph (graphiti-style
 * communities). Built off-hours by DreamsModule, which imports this for
 * CommunityBuilderService.
 *
 * CompactionModule is imported for the SUMMARY_GENERATOR token (shared
 * with compaction's warm-tier rollups). AiModule is @Global, so
 * EmbedderService is auto-injected.
 */
@Module({
  imports: [ConfigModule, CompactionModule],
  providers: [CommunityBuilderService, CommunityService],
  exports: [CommunityBuilderService, CommunityService],
})
export class CommunityModule {}
