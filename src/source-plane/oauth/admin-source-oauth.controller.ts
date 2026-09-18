import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ZodType } from 'zod';
import { ApiKeyGuard, RequireScopes } from '../../auth/api-key.guard';
import type { AuthenticatedRequest } from '../../auth/api-key.types';
import { requestBaseUrl } from '../../auth/resource-metadata';
import {
  sourceOAuthClientEnabled,
  sourceOAuthRedirectUrl,
  sourcePlaneEnabled,
} from '../../common/source-plane-flags';
import {
  SourceOAuthStartRequestSchema,
  isGrantId,
  type RevokeGrantResponse,
  type SourceOAuthGrantsResponse,
  type SourceOAuthStartResponse,
} from '../../contracts/source-plane/source-plane.schema';
import { SOURCE_CONNECTORS, findConnector, type ConnectorRegistry } from '../connector';
import { SourceOAuthService } from './source-oauth.service';

/** The public callback's path — what a provider must have as the app's redirect URI. */
export const OAUTH_CALLBACK_PATH = '/v1/source-connections/oauth/callback';

/**
 * Connected accounts (brain:admin) — the brain as an outbound OAuth
 * client (W4). Registered BEFORE the connections controller so its
 * literal `oauth/…` segments are never read as a connection id.
 *
 *   POST   /v1/admin/source-connections/oauth/start        ⇒ { authorizeUrl, state }
 *   GET    /v1/admin/source-connections/oauth/grants       the accounts connected + provider readiness
 *   DELETE /v1/admin/source-connections/oauth/grants/:id   disconnect (revoked at the provider, best effort)
 *
 * Bare 404 while SOURCE_PLANE_ENABLED or SOURCE_OAUTH_CLIENT is off.
 */
@Controller('v1/admin/source-connections/oauth')
@UseGuards(ApiKeyGuard)
export class AdminSourceOAuthController {
  constructor(
    private readonly oauth: SourceOAuthService,
    @Optional() @Inject(SOURCE_CONNECTORS) private readonly connectors?: ConnectorRegistry,
  ) {}

  @Post('start')
  @RequireScopes('brain:admin')
  async start(
    @Req() req: AuthenticatedRequest & Request,
    @Body() body: unknown,
  ): Promise<SourceOAuthStartResponse> {
    assertEnabled();
    const dto = parseBody(SourceOAuthStartRequestSchema, body);
    const connector = findConnector(this.connectors ?? [], dto.connector);
    if (!connector?.oauth) {
      throw new BadRequestException(
        `connector "${dto.connector}" does not authenticate through a connected account`,
      );
    }
    if (connector.oauth.provider !== dto.provider) {
      throw new BadRequestException(
        `connector "${dto.connector}" speaks ${connector.oauth.provider}, not ${dto.provider}`,
      );
    }
    return this.oauth.start(req.brainAuth.companyId, {
      provider: dto.provider,
      scopes: connector.oauth.scopes,
      redirectUri: redirectUriOf(req),
      origin: dto.origin,
      actor: req.brainAuth.actorId ?? req.brainAuth.userId ?? 'admin',
      userId: dto.ownerUserId,
    });
  }

  @Get('grants')
  @RequireScopes('brain:admin')
  async grants(@Req() req: AuthenticatedRequest & Request): Promise<SourceOAuthGrantsResponse> {
    assertEnabled();
    return {
      grants: await this.oauth.list(req.brainAuth.companyId),
      providers: this.oauth.providers(redirectUriOf(req)),
      ready: this.oauth.ready(),
    };
  }

  @Delete('grants/:id')
  @RequireScopes('brain:admin')
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<RevokeGrantResponse> {
    assertEnabled();
    return this.oauth.revoke(req.brainAuth.companyId, assertGrantId(id));
  }
}

function assertEnabled(): void {
  if (!sourcePlaneEnabled() || !sourceOAuthClientEnabled()) throw new NotFoundException();
}

/** Where the provider sends the browser back: the configured URL, else this brain as the admin reached it. */
export function redirectUriOf(req: Request): string {
  const configured = sourceOAuthRedirectUrl();
  if (configured) return configured;
  const base = requestBaseUrl(req);
  if (!base)
    throw new BadRequestException(
      'cannot determine the public base URL — set SOURCE_OAUTH_REDIRECT_URL',
    );
  return `${base}${OAUTH_CALLBACK_PATH}`;
}

function assertGrantId(id: string): string {
  const full = id.startsWith('source_oauth_grant:') ? id : `source_oauth_grant:${id}`;
  if (!isGrantId(full)) throw new BadRequestException('invalid grant id');
  return full;
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      error: 'validation_failed',
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
