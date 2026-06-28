import { Global, Module } from '@nestjs/common';
import { EmbedderService } from './embedder.service';
import { ExtractorService } from './extractor.service';
import { RerankerService } from './reranker.service';
import { HypeService } from './hype.service';
import { PredicateRouterService } from './predicate-router.service';
import { CrossEncoderService } from './cross-encoder.service';
import { PredicateRegistryService } from './predicate-registry.service';
import { LocalPredicateSelectorService } from './local-predicate-selector.service';
import { ExtractorCacheService } from './extractor-cache.service';
import { LocalNerService } from './local-ner.service';
import { ExtractionPatternService } from './extraction-pattern.service';
import { CalibrationService } from './calibration/calibration.service';
import { CalibrationRefitService } from './calibration/calibration-refit.service';
import { ReindexEmbeddingsService } from './embedder/reindex-embeddings.service';
import { ReindexEngineService } from './embedder/reindex-engine.service';
import { EntityJudgeService } from './entity-judge.service';

@Global()
@Module({
  // ScheduleModule.forRoot() lives in AppModule; @Cron providers here are
  // discovered by the global scheduler without a local registration.
  providers: [
    EmbedderService,
    ExtractorService,
    RerankerService,
    HypeService,
    PredicateRouterService,
    CrossEncoderService,
    PredicateRegistryService,
    LocalPredicateSelectorService,
    ExtractorCacheService,
    LocalNerService,
    ExtractionPatternService,
    CalibrationService,
    CalibrationRefitService,
    ReindexEngineService,
    ReindexEmbeddingsService,
    EntityJudgeService,
  ],
  exports: [
    EmbedderService,
    ExtractorService,
    RerankerService,
    HypeService,
    PredicateRouterService,
    CrossEncoderService,
    PredicateRegistryService,
    LocalPredicateSelectorService,
    ExtractorCacheService,
    LocalNerService,
    ExtractionPatternService,
    CalibrationService,
    CalibrationRefitService,
    ReindexEmbeddingsService,
    EntityJudgeService,
  ],
})
export class AiModule {}
