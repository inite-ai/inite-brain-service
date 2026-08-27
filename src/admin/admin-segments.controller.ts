import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import { SegmentComposerService, SegmentRunResult } from './segment-composer.service';
import { SegmentBackfillService, SegmentBackfillResult } from './segment-backfill.service';

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
    private readonly backfill: SegmentBackfillService,
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

  /**
   * 0117 backfill: stamp `userIds` on legacy segment rows so the
   * PRIVACY_SEGMENT_USER_FENCE (fail-closed on `userIds IS NONE`) can
   * be enabled without hiding pre-0117 windows. Run once per tenant
   * BEFORE the first fence enable on an existing deployment. Scenes are
   * not covered — re-run POST /v1/admin/maintenance/scenes instead
   * (see SegmentBackfillService).
   */
  @Post('maintenance/segments/backfill-user-ids')
  @RequireScopes('brain:admin')
  async backfillUserIds(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; maxRows?: number } = {},
  ): Promise<SegmentBackfillResult> {
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.backfill.backfillUserIds(tenant, { maxRows: body.maxRows });
  }
}
