import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { requestBaseUrl } from '../auth/resource-metadata';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import type {
  IssuedKeyResponse,
  KeyListResponse,
  RevokeKeyResponse,
} from '../contracts/keys/keys.schema';
import { IssueKeyDto } from './dto/issue-key.dto';
import { KeysService } from './keys.service';

/**
 * Self-serve API keys.
 *
 * The hosted product had no path from "I have an account" to "I have a
 * credential": the app screen showed placeholder snippets, the admin
 * keys endpoint was read-only, and issuance happened by email. A
 * self-hosted deployment had it worse — editing BRAIN_API_KEYS and
 * restarting. This surface issues keys brain itself verifies, so both
 * deployments work the same way.
 *
 * Every route requires `brain:read` and nothing more: authority is
 * bounded by what the caller already holds (KeysService narrows the
 * grant), not by a separate scope. The response carries the tenant's
 * `companyId` and MCP URL alongside the key, because those are the three
 * values every client config needs and the pair was previously
 * impossible to discover from inside the product.
 */
@Controller('v1/keys')
@UseGuards(ApiKeyGuard)
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Get()
  @RequireScopes('brain:read')
  @PolicyAction('rest.keys.list')
  async list(@Req() req: AuthenticatedRequest & Request): Promise<KeyListResponse> {
    const auth = req.brainAuth;
    return {
      companyId: auth.companyId,
      mcpUrl: this.mcpUrl(req),
      keys: await this.keys.list(auth),
      issuingEnabled: this.keys.enabled(),
      issuableScopes: this.keys.issuableScopes(auth),
    };
  }

  // Minting is cheap for us and expensive to clean up after; cap it well
  // below the default so a runaway script cannot fill a tenant's quota
  // faster than a human notices.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  @Post()
  @RequireScopes('brain:read')
  @PolicyAction('rest.keys.issue')
  async issue(
    @Req() req: AuthenticatedRequest & Request,
    @Body() body: IssueKeyDto,
  ): Promise<IssuedKeyResponse> {
    const auth = req.brainAuth;
    const issued = await this.keys.issue(auth, body);
    return {
      key: issued.key,
      companyId: auth.companyId,
      mcpUrl: this.mcpUrl(req),
      keyRecord: issued.summary,
    };
  }

  @Post(':id/revoke')
  @RequireScopes('brain:read')
  @PolicyAction('rest.keys.revoke')
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<RevokeKeyResponse> {
    return { revoked: await this.keys.revoke(req.brainAuth, id) };
  }

  /** The endpoint a client config points at, as this caller reached us. */
  private mcpUrl(req: AuthenticatedRequest & Request): string {
    const base = requestBaseUrl(req) ?? 'https://brain.inite.ai';
    return `${base}/mcp/${req.brainAuth.companyId}`;
  }
}
