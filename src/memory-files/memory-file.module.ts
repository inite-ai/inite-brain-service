import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MemoryFileService } from './memory-file.service';
import { MemoryFileController } from './memory-file.controller';

/**
 * File-shaped memory — the storage behind the Anthropic memory tool
 * (`memory_20250818`). SurrealService is @Global; AuthModule supplies
 * the ApiKeyGuard. The service is exported so a future MCP tool family
 * can serve the same files without a second implementation.
 */
@Module({
  imports: [AuthModule],
  controllers: [MemoryFileController],
  providers: [MemoryFileService],
  exports: [MemoryFileService],
})
export class MemoryFileModule {}
