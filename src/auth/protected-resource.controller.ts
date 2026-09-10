import { Controller, Get, Header, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { requestBaseUrl, resourcePathSuffix } from './resource-metadata';

interface ProtectedResourceMetadata {
  resource: string;
  resource_name: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
}

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * Advertises which authorization server protects this brain deployment
 * and which scopes it understands, so MCP clients auto-onboard: 401 →
 * WWW-Authenticate resource_metadata → this document → auth.inite.ai
 * (dynamic client registration + device/PKCE flow). Public by design,
 * like the MCP health probe.
 *
 * Two routes, one document. `/.well-known/oauth-protected-resource` is
 * the deployment-wide identifier named in the 401 challenge; the
 * path-suffixed form (`…/oauth-protected-resource/mcp/<companyId>`) is
 * what a client constructs on its own for a resource that lives under a
 * path, and it answers for the tenant endpoint specifically.
 *
 * Both must reach this service from the edge. The public host also
 * fronts the marketing site, so the proxy has to route
 * `/.well-known/oauth-protected-resource` here — otherwise the challenge
 * points at a 404 and discovery dead-ends. See docs/DEPLOY.md.
 */
@Controller('.well-known')
export class ProtectedResourceController {
  constructor(private readonly config: ConfigService) {}

  @Get('oauth-protected-resource')
  @Header('Content-Type', 'application/json')
  metadata(@Req() req: Request): ProtectedResourceMetadata {
    return this.document(req, '');
  }

  @Get('oauth-protected-resource/*path')
  @Header('Content-Type', 'application/json')
  metadataForPath(@Req() req: Request): ProtectedResourceMetadata {
    return this.document(req, resourcePathSuffix(req));
  }

  private document(req: Request, suffix: string): ProtectedResourceMetadata {
    const issuer =
      this.config.get<string>('AUTH_SERVICE_ISSUER') ??
      this.config.get<string>('AUTH_SERVICE_URL', 'https://auth.inite.ai');
    const base = requestBaseUrl(req) ?? 'https://brain.inite.ai';
    return {
      resource: `${base}${suffix}`,
      resource_name: 'INITE Brain',
      authorization_servers: [issuer],
      // The user-delegable surface. Integration scopes (indexer:write,
      // registry:publish) are operator-provisioned keys, not something
      // an MCP client should request on a user's behalf.
      scopes_supported: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
      bearer_methods_supported: ['header'],
      // Docs are served by the landing app under a language prefix;
      // `${base}/docs` is a 404 there.
      resource_documentation: `${base}/en/docs`,
    };
  }
}
