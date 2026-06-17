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

@Global()
@Module({
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
  ],
})
export class AiModule {}
