import { Global, Module } from '@nestjs/common';
import { EmbedderService } from './embedder.service';
import { ExtractorService } from './extractor.service';

@Global()
@Module({
  providers: [EmbedderService, ExtractorService],
  exports: [EmbedderService, ExtractorService],
})
export class AiModule {}
