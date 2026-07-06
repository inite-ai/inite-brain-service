import { Module } from '@nestjs/common';
import { CodeMemorySearchService } from './code-memory-search.service';
import { CodeMemoryAnchorService } from './code-memory-anchor.service';

/**
 * Server-side code-memory services: semantic retrieval (Phase 3b) + anchor
 * re-validation (Phase 2b). SurrealService + EmbedderService come from their
 * @Global modules; this module declares + exports the code-memory-specific
 * services for the MCP + admin surfaces.
 */
@Module({
  providers: [CodeMemorySearchService, CodeMemoryAnchorService],
  exports: [CodeMemorySearchService, CodeMemoryAnchorService],
})
export class CodeMemoryModule {}
