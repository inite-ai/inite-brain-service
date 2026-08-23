import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { envFlagNotDisabled } from '../common/env-validation';
import { EmbedderService } from './embedder.service';
import { ExtractorService } from './extractor.service';
import { ExtractorRunnerService } from './extractor-runner.service';
import { ExtractorLlmService } from './extractor-llm.service';
import { ExtractorLocalService } from './extractor-local.service';
import { ExtractorRefineService } from './extractor-refine.service';
import { RerankerService } from './reranker.service';
import { CrossEncoderService } from './cross-encoder.service';
import { LocalCrossEncoderProvider } from './cross-encoder/local-cross-encoder.provider';
import { PredicateRegistryService } from './predicate-registry.service';
import { LocalPredicateSelectorService } from './local-predicate-selector.service';
import { ExtractorCacheService } from './extractor-cache.service';
import { LocalNerService } from './local-ner.service';
import { ExtractionPatternService } from './extraction-pattern.service';
import { CalibrationService } from './calibration/calibration.service';
import { CalibrationRefitService } from './calibration/calibration-refit.service';
import { CalibrationRefitRunnerService } from './calibration/calibration-refit-runner.service';
import { CalibrationRefitQueueService } from './calibration/calibration-refit-queue.service';
import { CalibrationRefitJobService } from './calibration/calibration-refit-job.service';
import { ReindexEmbeddingsService } from './embedder/reindex-embeddings.service';
import { ReindexEngineService } from './embedder/reindex-engine.service';
import { EntityJudgeService } from './entity-judge.service';

@Global()
@Module({
  // ScheduleModule.forRoot() lives in AppModule; @Cron providers here are
  // discovered by the global scheduler without a local registration.
  providers: [
    EmbedderService,
    ExtractorLlmService,
    ExtractorLocalService,
    ExtractorRefineService,
    ExtractorRunnerService,
    ExtractorService,
    RerankerService,
    CrossEncoderService,
    PredicateRegistryService,
    LocalPredicateSelectorService,
    ExtractorCacheService,
    LocalNerService,
    ExtractionPatternService,
    {
      // Local cross-encoder fallback (no-Cohere-key rerank). Construction is
      // cheap — the ONNX model lazy-loads on first use — so it's always
      // provided; CrossEncoderService invokes it when Cohere isn't
      // configured.
      provide: LocalCrossEncoderProvider,
      useFactory: (config: ConfigService) =>
        new LocalCrossEncoderProvider({
          modelId: config.get<string>(
            'SEARCH_CROSS_ENCODER_LOCAL_MODEL',
            'Xenova/bge-reranker-base',
          ),
          // ONNX inference runs in a worker_thread by default so it never
          // blocks the main event loop; SEARCH_CROSS_ENCODER_LOCAL_WORKER=0
          // keeps the in-thread path (benchmarks / constrained envs).
          useWorker: envFlagNotDisabled(config.get<string>('SEARCH_CROSS_ENCODER_LOCAL_WORKER')),
          scoreTimeoutMs: parseInt(
            config.get<string>('SEARCH_STAGE_BUDGET_CROSS_ENCODER_MS', '2000'),
            10,
          ),
        }),
      inject: [ConfigService],
    },
    CalibrationService,
    CalibrationRefitRunnerService,
    CalibrationRefitQueueService,
    CalibrationRefitJobService,
    CalibrationRefitService,
    ReindexEngineService,
    ReindexEmbeddingsService,
    EntityJudgeService,
  ],
  exports: [
    EmbedderService,
    ExtractorService,
    // Exposed for dedicated indexer runs (src/indexers): a pack-scoped
    // extraction reuses the runner + cache directly with a filtered
    // snapshot instead of duplicating the engine.
    ExtractorRunnerService,
    RerankerService,
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
