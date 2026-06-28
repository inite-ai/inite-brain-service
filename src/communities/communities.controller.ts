import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { CommunityService } from './community.service';

/**
 * Read-only REST surface over topic communities — the same data the
 * `list_communities` / `search_communities` / `find_entity_communities`
 * MCP tools expose, for the end-user app UI. All read-scope.
 */
@Controller('v1/communities')
@UseGuards(ApiKeyGuard)
export class CommunitiesController {
  constructor(private readonly communities: CommunityService) {}

  @Get()
  @RequireScopes('brain:read')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ) {
    const communities = await this.communities.list(req.brainAuth.companyId, {
      limit: parseLimit(limit, 50, 200),
    });
    return { communities };
  }

  // eslint-disable-next-line max-params -- decorated HTTP route handler; each param is a @Req/@Query binding, cannot be folded into an options object without breaking Nest param resolution
  @Get('search')
  @RequireScopes('brain:read')
  async search(
    @Req() req: AuthenticatedRequest,
    @Query('query') query?: string,
    @Query('limit') limit?: string,
    @Query('minSimilarity') minSimilarity?: string,
  ) {
    const q = (query ?? '').trim();
    if (!q) return { communities: [] };
    const communities = await this.communities.search(req.brainAuth.companyId, {
      query: q,
      limit: parseLimit(limit, 5, 20),
      minSimilarity: parseSimilarity(minSimilarity),
    });
    return { communities };
  }

  @Get('for-entity/:entityId')
  @RequireScopes('brain:read')
  async forEntity(
    @Req() req: AuthenticatedRequest,
    @Param('entityId') entityId: string,
  ) {
    const communities = await this.communities.forEntity(
      req.brainAuth.companyId,
      entityId,
    );
    return { communities };
  }
}

function parseLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parseSimilarity(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(n, 0), 1);
}
