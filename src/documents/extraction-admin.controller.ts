import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import { ExtractionBatchService } from './extraction-batch.service';

/**
 * POST /v1/admin/maintenance/extraction — read what is waiting NOW.
 *
 * Captured documents are read by the batch pass a short window after they
 * arrive (extraction-batch.service.ts). This runs that pass on request
 * and answers its counts once everything waiting has been read — for an
 * operator draining a backlog, and for a harness that writes a corpus and
 * then asks about it (the sibling of maintenance/scenes). A conversation
 * still talking is read too (the pass otherwise waits for it to go quiet);
 * `retry: true` also re-reads what earlier passes failed.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class ExtractionAdminController {
  constructor(
    private readonly batch: ExtractionBatchService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/extraction')
  @RequireScopes('brain:admin')
  async drain(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; retry?: boolean } = {},
  ): Promise<{ read: number; failed: number; committed: number; retry: number }> {
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.batch.runPass(tenant, { retry: body.retry === true ? 1 : 0, force: true });
  }
}
