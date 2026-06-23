import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { SearchModule } from '../search/search.module';
import { EntitiesModule } from '../entities/entities.module';
import { IngestModule } from '../ingest/ingest.module';
import { FactsModule } from '../facts/facts.module';
import { MultiHopModule } from '../multi-hop/multi-hop.module';
import { SynthesizeModule } from '../synthesize/synthesize.module';

@Module({
  imports: [
    SearchModule,
    EntitiesModule,
    IngestModule,
    FactsModule,
    MultiHopModule,
    SynthesizeModule,
  ],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
