import { Module } from '@nestjs/common';
import { EpisodesModule } from '../episodes/episodes.module';
import { OutcomesModule } from '../outcomes/outcomes.module';
import { SourcePlaneModule } from '../source-plane/source-plane.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRetrievalService } from './search-retrieval.service';
import { SearchRerankService } from './search-rerank.service';

@Module({
  // EpisodesModule supplies ReadPinService — the per-tenant derived-world
  // pin the read path resolves before building its WHERE (audit W2).
  // OutcomesModule supplies the 0107 `retrieved` outcome writer.
  // SourcePlaneModule supplies the progressive-indexing hook (W6): a
  // query that matched a manifest-only catalogue row schedules its
  // deepening. Injected @Optional() and gated twice (SOURCE_PLANE_ENABLED
  // + SOURCE_PROGRESSIVE), so it is inert unless an operator asked.
  imports: [EpisodesModule, OutcomesModule, SourcePlaneModule],
  controllers: [SearchController],
  providers: [SearchService, SearchRetrievalService, SearchRerankService],
  exports: [SearchService],
})
export class SearchModule {}
