import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { StatsService } from './stats.service';

/**
 * Per-company memory stats for the end-user "Usage" page. Read-scope;
 * companyId comes from the authenticated credential.
 */
@Controller('v1/stats')
@UseGuards(ApiKeyGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('overview')
  @RequireScopes('brain:read')
  async overview(@Req() req: AuthenticatedRequest) {
    return this.stats.overview(req.brainAuth.companyId, req.brainAuth.scopes);
  }
}
