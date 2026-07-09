import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import {
  HnswMaintenanceService,
  HnswMaintenanceResult,
} from './hnsw-maintenance.service';

/**
 * Synchronous by design (unlike the 202-job maintenance triggers):
 * DEFINE INDEX either applies or throws, and the operator flipping
 * SEARCH_HNSW_ENABLED needs to know which before touching the flag.
 * On a large tenant the build can take a while — run off-peak.
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
    @Body() body: { action?: 'create' | 'drop'; tenant?: string } = {},
  ): Promise<HnswMaintenanceResult> {
    const action = body.action ?? 'create';
    if (action !== 'create' && action !== 'drop') {
      throw new BadRequestException(`action must be 'create' or 'drop'`);
    }
    const tenant = body.tenant?.trim() || req.brainAuth.companyId;
    if (
      tenant !== req.brainAuth.companyId &&
      !this.apiKeys.knownCompanyIds().includes(tenant)
    ) {
      throw new BadRequestException(
        `Unknown tenant '${tenant}' — not a registered tenant`,
      );
    }
    return this.hnsw.apply(tenant, action);
  }
}
