import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { DedicatedExtractorService } from './dedicated-extractor.service';
import { IndexerRouterService } from './indexer-router.service';

/**
 * The Indexer layer's execution machinery: pack-scoped dedicated
 * extraction (same engine as the union extractor, filtered snapshot) and
 * the relevance router that decides which dedicated indexers read a
 * document. Consumed by DocumentsModule; pure helpers (virtual-attributor,
 * snapshot-filter, routing) are plain modules, not providers.
 */
@Module({
  imports: [AiModule],
  providers: [DedicatedExtractorService, IndexerRouterService],
  exports: [DedicatedExtractorService, IndexerRouterService],
})
export class IndexersModule {}
