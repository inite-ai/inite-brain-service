import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import { SegmentComposerService, SegmentRunResult } from './segment-composer.service';

/**
 * Explicit trigger for the L0 segment composer (memory-rebuild R1).
 * Embedding-only cost (no LLM); idempotent per conversation
 * (delete-by-conversation then insert). Enable the read lane afterwards
 * with SEARCH_SEGMENT_LANE_ENABLED.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminSegmentsController {
  constructor(
    private readonly composer: SegmentComposerService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/segments')
  @RequireScopes('brain:admin')
  async run(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string } = {},
  ): Promise<SegmentRunResult> {
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.composer.run(tenant);
  }
}
