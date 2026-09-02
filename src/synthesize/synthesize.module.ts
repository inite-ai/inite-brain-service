import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { EpisodesModule } from '../episodes/episodes.module';
import { AnswerCacheModule } from '../answer-cache/answer-cache.module';
import { StrategyModule } from '../strategy/strategy.module';
import { OutcomesModule } from '../outcomes/outcomes.module';
import { SynthesizeController } from './synthesize.controller';
import { FocusAdminController } from './focus-admin.controller';
import { LensAdminController } from './lens-admin.controller';
import { SynthesizeService } from './synthesize.service';
import { FocusSignalService } from './focus-signal.service';
import { LensSuppressionService } from './lens-suppression.service';
import { MultilingualLaneClassifierService } from './multilingual-lane-classifier.service';
import { EpisodeLaneService } from './episode-lane.service';
import { SegmentLaneService } from './segment-lane.service';
import { InsightLaneService } from './insight-lane.service';
import { MentionScanService } from './mention-scan.service';
import { QueryArcService } from './query-arc.service';
import { UpdateStoryService } from './update-story.service';
import { DigestLaneService } from './digest-lane.service';
import { FragmentLaneService } from './fragment-lane.service';
import { EvidenceCollectorService } from './evidence-collector.service';
import { L3EscalationService } from './l3-escalation.service';
import { MemoryModelReaderService } from '../ai/memory-model-reader.service';

@Module({
  imports: [SearchModule, EpisodesModule, AnswerCacheModule, StrategyModule, OutcomesModule],
  controllers: [SynthesizeController, FocusAdminController, LensAdminController],
  providers: [
    SynthesizeService,
    FocusSignalService,
    LensSuppressionService,
    MultilingualLaneClassifierService,
    EvidenceCollectorService,
    EpisodeLaneService,
    SegmentLaneService,
    InsightLaneService,
    MentionScanService,
    QueryArcService,
    UpdateStoryService,
    DigestLaneService,
    FragmentLaneService,
    L3EscalationService,
    // FOVEA_ATTENTION_HINTS: the L3 escalation lane's lazy read of pack
    // memory models. A second DI instance beside admin.module's — its
    // LRU+TTL cache (30s) is per-instance, so an install/uninstall
    // invalidation lands on admin's copy and this one refreshes within
    // the TTL; acceptable staleness for an ordering-only hint.
    MemoryModelReaderService,
  ],
  exports: [SynthesizeService],
})
export class SynthesizeModule {}
