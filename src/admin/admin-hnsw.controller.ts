import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import { HnswMaintenanceService, HnswMaintenanceResult } from './hnsw-maintenance.service';

/**
 * Synchronous by design (unlike the 202-job maintenance triggers): the
 * operator flipping SEARCH_HNSW_ENABLED needs to know whether the tenant's
 * indexes are usable before touching the flag. On a large tenant the build
 * can take a while — run off-peak.
 *
 * "Either applies or throws" was the old contract and it was never true of
 * the outcome that matters. With SEARCH_HNSW_CONCURRENT on, the DDL returns
 * in ~20 ms and the build continues in the background; an index that exists
 * but is still `indexing` answers a KNN query with the same unranked,
 * null-distance rows a MISSING index does. So the response reports the
 * per-index build state and a single `ready` boolean, and `action:'status'`
 * re-reads it without emitting any DDL. Do not flip SEARCH_HNSW_ENABLED for
 * a tenant while `ready` is false.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminHnswController {
  constructor(
    private readonly hnsw: HnswMaintenanceService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/hnsw')
  @RequireScopes('brain:admin')
  async apply(
    @Req() req: AuthenticatedRequest,
    @Body() body: { action?: 'create' | 'drop' | 'status'; tenant?: string } = {},
  ): Promise<HnswMaintenanceResult> {
    const action = body.action ?? 'create';
    if (action !== 'create' && action !== 'drop' && action !== 'status') {
      throw new BadRequestException(`action must be 'create', 'drop' or 'status'`);
    }
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.hnsw.apply(tenant, action);
  }
}
