import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { AgentQaController } from './agent-qa.controller';
import { AgentQaService } from './agent-qa.service';

/**
 * Agent-in-loop QA. Reuses SearchService (all retrieval machinery) as the
 * single tool the answering LLM calls iteratively. No new storage-side deps.
 */
@Module({
  imports: [SearchModule],
  controllers: [AgentQaController],
  providers: [AgentQaService],
  exports: [AgentQaService],
})
export class AgentQaModule {}
