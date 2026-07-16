import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { PackToolsReaderService } from './pack-tools-reader.service';
import { SearchModule } from '../search/search.module';
import { EntitiesModule } from '../entities/entities.module';
import { IngestModule } from '../ingest/ingest.module';
import { FactsModule } from '../facts/facts.module';
import { MultiHopModule } from '../multi-hop/multi-hop.module';
import { SynthesizeModule } from '../synthesize/synthesize.module';
import { DiffModule } from '../diff/diff.module';
import { SummarizeEntityModule } from '../summarize-entity/summarize-entity.module';
import { ProceduralModule } from '../procedural/procedural.module';
import { CommunityModule } from '../communities/community.module';
import { CodeMemoryModule } from '../code-memory/code-memory.module';
import { SourcesModule } from '../sources/sources.module';
import { DocumentsModule } from '../documents/documents.module';
import { FeedbackModule } from '../feedback/feedback.module';

@Module({
  imports: [
    SearchModule,
    EntitiesModule,
    IngestModule,
    FactsModule,
    MultiHopModule,
    SynthesizeModule,
    DiffModule,
    SummarizeEntityModule,
    ProceduralModule,
    CommunityModule,
    CodeMemoryModule,
    SourcesModule,
    DocumentsModule,
    FeedbackModule,
  ],
  controllers: [McpController],
  providers: [McpService, PackToolsReaderService],
  // Exported for DomainPackInstallService's cache invalidation hook
  // (AdminModule imports McpModule).
  exports: [PackToolsReaderService],
})
export class McpModule {}
