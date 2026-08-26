import { Module } from '@nestjs/common';
import { EpisodesModule } from '../episodes/episodes.module';
import { OutcomesModule } from '../outcomes/outcomes.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRetrievalService } from './search-retrieval.service';
import { SearchRerankService } from './search-rerank.service';

@Module({
  // EpisodesModule supplies ReadPinService — the per-tenant derived-world
  // pin the read path resolves before building its WHERE (audit W2).
  // OutcomesModule supplies the 0107 `retrieved` outcome writer.
  imports: [EpisodesModule, OutcomesModule],
  controllers: [SearchController],
  providers: [SearchService, SearchRetrievalService, SearchRerankService],
  exports: [SearchService],
})
export class SearchModule {}
