import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { EpisodesModule } from '../episodes/episodes.module';
import { SynthesizeController } from './synthesize.controller';
import { SynthesizeService } from './synthesize.service';
import { EpisodeLaneService } from './episode-lane.service';
import { SegmentLaneService } from './segment-lane.service';
import { InsightLaneService } from './insight-lane.service';
import { MentionScanService } from './mention-scan.service';
import { QueryArcService } from './query-arc.service';
import { UpdateStoryService } from './update-story.service';
import { EvidenceCollectorService } from './evidence-collector.service';

@Module({
  imports: [SearchModule, EpisodesModule],
  controllers: [SynthesizeController],
  providers: [
    SynthesizeService,
    EvidenceCollectorService,
    EpisodeLaneService,
    SegmentLaneService,
    InsightLaneService,
    MentionScanService,
    QueryArcService,
    UpdateStoryService,
  ],
  exports: [SynthesizeService],
})
export class SynthesizeModule {}
