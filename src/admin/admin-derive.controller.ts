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
  WindowDeriverService,
  DeriveRunResult,
  WINDOW_DERIVER_VERSION,
} from './window-deriver.service';

/**
 * Explicit trigger for the session-window batch deriver (P3 v1). One LLM
 * call per session over the L0 substrate — a paid, operator-invoked
 * batch, never ambient. Re-runs replace the version's facts per
 * conversation (delete-by-version), so the endpoint is idempotent. Flip
 * the read world afterwards with RETRIEVAL_DERIVED_VERSION.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminDeriveController {
  constructor(
    private readonly deriver: WindowDeriverService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/derive')
  @RequireScopes('brain:admin')
  async run(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: { tenant?: string; version?: string; conversation?: string } = {},
  ): Promise<DeriveRunResult> {
    const tenant = body.tenant?.trim() || req.brainAuth.companyId;
    if (
      tenant !== req.brainAuth.companyId &&
      !this.apiKeys.knownCompanyIds().includes(tenant)
    ) {
      throw new BadRequestException(
        `Unknown tenant '${tenant}' — not a registered tenant`,
      );
    }
    const version = body.version?.trim() || WINDOW_DERIVER_VERSION;
    if (!/^[a-z0-9-]{2,32}$/.test(version)) {
      throw new BadRequestException(
        'version must be a short kebab-case tag (e.g. wd-v2)',
      );
    }
    const conversationId = body.conversation?.trim() || undefined;
    if (conversationId && conversationId.length > 128) {
      throw new BadRequestException('conversation id too long');
    }
    return this.deriver.run(tenant, { version, conversationId });
  }
}
