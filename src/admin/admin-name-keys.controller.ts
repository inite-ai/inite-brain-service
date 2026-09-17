import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import { NameKeyBackfillService, NameKeyBackfillResult } from './name-key-backfill.service';

/**
 * Migration 0148 backfill trigger: stamp `nameKeys` onto entities written
 * before the field existed, so the cross-script name match can see them.
 *
 * Synchronous and paged rather than a 202 job: it is one cheap UPDATE per
 * row with no LLM and no embedding in it, and an operator running it wants
 * the `remaining` count back to decide whether to call again. Idempotent —
 * re-running only touches rows still missing the field.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminNameKeysController {
  constructor(
    private readonly backfill: NameKeyBackfillService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/entities/backfill-name-keys')
  @RequireScopes('brain:admin')
  async backfillNameKeys(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; maxRows?: number } = {},
  ): Promise<NameKeyBackfillResult> {
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.backfill.run(tenant, body.maxRows);
  }
}
