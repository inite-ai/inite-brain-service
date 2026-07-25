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
  AggregateComposerService,
  AggregateRunResult,
} from './aggregate-composer.service';

/**
 * Explicit trigger for the Lane C aspect-aggregate composer (write-time
 * compute; costs one LLM call per composed entity). Synchronous like the
 * HNSW maintenance trigger: the operator wants the counts before relying
 * on aggregates in retrieval. Re-runs replace previous aggregates
 * wholesale (delete-by-recorder), so the endpoint is idempotent.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminAggregatesController {
  constructor(
    private readonly composer: AggregateComposerService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/aggregates')
  @RequireScopes('brain:admin')
  async run(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; entities?: number } = {},
  ): Promise<AggregateRunResult> {
    const tenant = body.tenant?.trim() || req.brainAuth.companyId;
    if (
      tenant !== req.brainAuth.companyId &&
      !this.apiKeys.knownCompanyIds().includes(tenant)
    ) {
      throw new BadRequestException(
        `Unknown tenant '${tenant}' — not a registered tenant`,
      );
    }
    return this.composer.run(tenant, { entities: body.entities });
  }
}
