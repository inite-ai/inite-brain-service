import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { StatsService } from './stats.service';

/**
 * Per-company memory stats for the end-user "Usage" page. Read-scope;
 * companyId comes from the authenticated credential. A userId-pinned
 * (end-user) token scopes the counts to its own + tenant-global memory
 * (audit F3) — brainAuth.userId is absent for M2M / admin callers, who
 * still see the tenant-wide aggregate.
 */
@Controller('v1/stats')
@UseGuards(ApiKeyGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('overview')
  @RequireScopes('brain:read')
  @PolicyAction('rest.stats.overview')
  async overview(@Req() req: AuthenticatedRequest) {
    return this.stats.overview(req.brainAuth.companyId, req.brainAuth.scopes, req.brainAuth.userId);
  }
}
