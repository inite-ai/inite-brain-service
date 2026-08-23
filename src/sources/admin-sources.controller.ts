import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { SourcesService } from './sources.service';
import type {
  DeclareSourceRequest,
  DeclareSourceResponse,
  SourceDetailResponse,
  SourcesListResponse,
} from '../contracts/sources/sources.schema';

/**
 * Operator-facing source registry + reputation reads. Until Phase 3 the
 * source_trust table was write-only from the operator's perspective (only
 * the resolver read it); these routes make reputation inspectable and let
 * an operator declare a source's type/authLevel — the latter activates the
 * resolver's dormant authority weight for that source (migration 0046).
 *
 * sourceKey path params carry a `:` (`vertical:recorder`) — a plain URL
 * path character, no special routing handling needed.
 */
@Controller('v1/admin/sources')
@UseGuards(ApiKeyGuard)
export class AdminSourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  @RequireScopes('brain:admin')
  async list(@Req() req: AuthenticatedRequest): Promise<SourcesListResponse> {
    const sources = await this.sources.list(req.brainAuth.companyId);
    return { sources } satisfies SourcesListResponse;
  }

  @Get(':sourceKey')
  @RequireScopes('brain:admin')
  async detail(
    @Req() req: AuthenticatedRequest,
    @Param('sourceKey') sourceKey: string,
  ): Promise<SourceDetailResponse> {
    return this.sources.detail(req.brainAuth.companyId, sourceKey);
  }

  @Put(':sourceKey')
  @RequireScopes('brain:admin')
  async declare(
    @Req() req: AuthenticatedRequest,
    @Param('sourceKey') sourceKey: string,
    @Body() body: DeclareSourceRequest,
  ): Promise<DeclareSourceResponse> {
    const declared = await this.sources.declare(req.brainAuth.companyId, sourceKey, body);
    return { declared } satisfies DeclareSourceResponse;
  }
}
