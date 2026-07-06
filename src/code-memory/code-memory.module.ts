import { Module } from '@nestjs/common';
import { CodeMemorySearchService } from './code-memory-search.service';

/**
 * Server-side code-memory retrieval (Phase 3b). SurrealService + EmbedderService
 * are provided by their @Global modules, so this module only declares the
 * code-memory-specific service and exports it for the MCP surface.
 */
@Module({
  providers: [CodeMemorySearchService],
  exports: [CodeMemorySearchService],
})
export class CodeMemoryModule {}
