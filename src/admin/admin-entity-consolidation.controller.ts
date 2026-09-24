import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import {
  ScopedEntityConsolidationService,
  type ConsolidationResult,
} from '../entities/scoped-entity-consolidation.service';

/**
 * On-demand run of the per-user entity-copy consolidation (see
 * ScopedEntityConsolidationService). The pass also runs by itself once per
 * (process, tenant) off the schema-ready hook; this route is for an
 * operator who wants the counts, or a tenant converged before its first
 * request of the day.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminEntityConsolidationController {
  constructor(
    private readonly consolidation: ScopedEntityConsolidationService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/entities/consolidate-scoped')
  @RequireScopes('brain:admin')
  async run(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string } = {},
  ): Promise<ConsolidationResult> {
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.consolidation.consolidate(tenant);
  }
}
