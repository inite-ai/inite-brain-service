import { Controller, Get, Header, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { requestBaseUrl } from './resource-metadata';

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * Advertises which authorization server protects this brain deployment
 * and which scopes it understands, so MCP clients auto-onboard: 401 →
 * WWW-Authenticate resource_metadata → this document → auth.inite.ai
 * (dynamic client registration + device/PKCE flow). Public by design,
 * like the MCP health probe.
 */
@Controller('.well-known')
export class ProtectedResourceController {
  constructor(private readonly config: ConfigService) {}

  @Get('oauth-protected-resource')
  @Header('Content-Type', 'application/json')
  metadata(@Req() req: Request) {
    const issuer =
      this.config.get<string>('AUTH_SERVICE_ISSUER') ??
      this.config.get<string>('AUTH_SERVICE_URL', 'https://auth.inite.ai');
    const resource = requestBaseUrl(req) ?? 'https://brain.inite.ai';
    return {
      resource,
      authorization_servers: [issuer],
      // The user-delegable surface. Integration scopes (indexer:write,
      // registry:publish) are operator-provisioned keys, not something
      // an MCP client should request on a user's behalf.
      scopes_supported: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${resource}/docs`,
    };
  }
}
