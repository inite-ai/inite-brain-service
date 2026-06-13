import { Global, Module } from '@nestjs/common';
import { EmbedderService } from './embedder.service';
import { ExtractorService } from './extractor.service';
import { RerankerService } from './reranker.service';
import { HypeService } from './hype.service';
import { PredicateRouterService } from './predicate-router.service';
import { CrossEncoderService } from './cross-encoder.service';
import { PredicateRegistryService } from './predicate-registry.service';

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
  ],
  exports: [
    EmbedderService,
    ExtractorService,
    RerankerService,
    HypeService,
    PredicateRouterService,
    CrossEncoderService,
    PredicateRegistryService,
  ],
})
export class AiModule {}
