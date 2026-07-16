import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcesService } from './sources.service';
import { AdminSourcesController } from './admin-sources.controller';
import { PublicSourcesController } from './public-sources.controller';

/**
 * Per-tenant source identity + reputation (source-reputation track,
 * Phase 3): the operator-declared source_registry joined with the
 * refit-computed source_trust under one sourceKey. SourcesService is
 * exported for the MCP get_source_reputation tool. SurrealService is
 * @Global; AuthModule supplies the ApiKeyGuard. PublicSourcesController
 * (trust-inputs track) serves the brain:read projection of the same data.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminSourcesController, PublicSourcesController],
  providers: [SourcesService],
  exports: [SourcesService],
})
export class SourcesModule {}
