import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { ArtifactsService, ArtifactType } from './artifacts.service';
import { AuthenticatedRequest } from '../auth/api-key.types';

/**
 * Compilation-stage artifact endpoint. Agent callers GET a typed,
 * pre-built bundle for an entity; the server returns it from cache
 * if fresh, else recompiles from the active fact set.
 *
 *   GET  /v1/artifacts/:type/:entityId    — read (cache or recompile)
 *   POST /v1/artifacts/:type/:entityId/recompile — force fresh build
 */
@Controller('v1/artifacts')
@UseGuards(ApiKeyGuard)
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Get(':type/:entityId')
  @RequireScopes('brain:read')
  async get(
    @Req() req: AuthenticatedRequest,
    @Param('type') type: string,
    @Param('entityId') entityId: string,
  ) {
    return this.artifacts.getArtifact(
      req.brainAuth.companyId,
      entityId,
      type as ArtifactType,
      req.brainAuth.scopes,
    );
  }

  @Post(':type/:entityId/recompile')
  @RequireScopes('brain:write')
  async recompile(
    @Req() req: AuthenticatedRequest,
    @Param('type') type: string,
    @Param('entityId') entityId: string,
  ) {
    return this.artifacts.recompileArtifact(
      req.brainAuth.companyId,
      entityId,
      type as ArtifactType,
      req.brainAuth.scopes,
    );
  }
}
