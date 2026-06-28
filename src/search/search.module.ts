import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRetrievalService } from './search-retrieval.service';
import { SearchRerankService } from './search-rerank.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService, SearchRetrievalService, SearchRerankService],
  exports: [SearchService],
})
export class SearchModule {}
