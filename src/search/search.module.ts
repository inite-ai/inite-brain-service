import { Module } from '@nestjs/common';
import { EpisodesModule } from '../episodes/episodes.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRetrievalService } from './search-retrieval.service';
import { SearchRerankService } from './search-rerank.service';

@Module({
  // EpisodesModule supplies ReadPinService — the per-tenant derived-world
  // pin the read path resolves before building its WHERE (audit W2).
  imports: [EpisodesModule],
  controllers: [SearchController],
  providers: [SearchService, SearchRetrievalService, SearchRerankService],
  exports: [SearchService],
})
export class SearchModule {}
