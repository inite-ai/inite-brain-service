import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { EpisodesModule } from '../episodes/episodes.module';
import { AnswerCacheModule } from '../answer-cache/answer-cache.module';
import { StrategyModule } from '../strategy/strategy.module';
import { SynthesizeController } from './synthesize.controller';
import { FocusAdminController } from './focus-admin.controller';
import { LensAdminController } from './lens-admin.controller';
import { SynthesizeService } from './synthesize.service';
import { FocusSignalService } from './focus-signal.service';
import { LensSuppressionService } from './lens-suppression.service';
import { EpisodeLaneService } from './episode-lane.service';
import { SegmentLaneService } from './segment-lane.service';
import { InsightLaneService } from './insight-lane.service';
import { MentionScanService } from './mention-scan.service';
import { QueryArcService } from './query-arc.service';
import { UpdateStoryService } from './update-story.service';
import { DigestLaneService } from './digest-lane.service';
import { EvidenceCollectorService } from './evidence-collector.service';
import { L3EscalationService } from './l3-escalation.service';

@Module({
  imports: [SearchModule, EpisodesModule, AnswerCacheModule, StrategyModule],
  controllers: [SynthesizeController, FocusAdminController, LensAdminController],
  providers: [
    SynthesizeService,
    FocusSignalService,
    LensSuppressionService,
    EvidenceCollectorService,
    EpisodeLaneService,
    SegmentLaneService,
    InsightLaneService,
    MentionScanService,
    QueryArcService,
    UpdateStoryService,
    DigestLaneService,
    L3EscalationService,
  ],
  exports: [SynthesizeService],
})
export class SynthesizeModule {}
