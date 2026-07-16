/**
 * RFC 9728 discovery surface: the well-known metadata document and the
 * WWW-Authenticate resource_metadata challenge on 401s — the pair that
 * lets an MCP client find auth.inite.ai and self-onboard.
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from '../src/auth/api-key.guard';
import { ProtectedResourceController } from '../src/auth/protected-resource.controller';
import {
  requestBaseUrl,
  resourceMetadataUrl,
} from '../src/auth/resource-metadata';

class StubConfig {
  constructor(private readonly map: Record<string, string>) {}
  get<T = string>(key: string, fallback?: T): T {
    return (this.map[key] as unknown as T) ?? (fallback as T);
  }
}

describe('resource-metadata helpers', () => {
  afterEach(() => {
    delete process.env.BRAIN_PUBLIC_URL;
  });

  it('derives the base URL from forwarding headers, then Host', () => {
    expect(
      requestBaseUrl({
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'brain.inite.ai',
          host: 'internal:3000',
        },
      }),
    ).toBe('https://brain.inite.ai');
    expect(requestBaseUrl({ headers: { host: 'localhost:3000' }, protocol: 'http' })).toBe(
      'http://localhost:3000',
    );
    expect(requestBaseUrl({ headers: {} })).toBeNull();
  });

  it('BRAIN_PUBLIC_URL wins as the canonical resource identifier', () => {
    process.env.BRAIN_PUBLIC_URL = 'https://brain.inite.ai/';
    expect(resourceMetadataUrl({ headers: { host: 'other.host' } })).toBe(
      'https://brain.inite.ai/.well-known/oauth-protected-resource',
    );
  });
});

describe('ProtectedResourceController', () => {
  it('advertises the authorization server and the user-delegable scopes', () => {
    const controller = new ProtectedResourceController(
      new StubConfig({
        AUTH_SERVICE_ISSUER: 'https://auth.inite.ai',
      }) as unknown as ConfigService,
    );
    const doc = controller.metadata({
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'brain.inite.ai' },
    } as never);
    expect(doc.resource).toBe('https://brain.inite.ai');
    expect(doc.authorization_servers).toEqual(['https://auth.inite.ai']);
    expect(doc.scopes_supported).toContain('brain:read');
    expect(doc.scopes_supported).not.toContain('indexer:write');
    expect(doc.bearer_methods_supported).toEqual(['header']);
  });
});

describe('ApiKeyGuard — WWW-Authenticate challenge', () => {
  it('401 carries resource_metadata so MCP clients can discover the AS', async () => {
    const headersSet: Record<string, string> = {};
    const req = { headers: { host: 'brain.inite.ai', authorization: undefined } };
    const res = {
      setHeader: (name: string, value: string) => {
        headersSet[name] = value;
      },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    // Credential resolver is never reached on the missing-header path.
    const guard = new ApiKeyGuard(
      { resolve: async () => null } as never,
      new Reflector(),
      { gate: async () => undefined } as never,
    );

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(headersSet['WWW-Authenticate']).toBe(
      'Bearer resource_metadata="https://brain.inite.ai/.well-known/oauth-protected-resource"',
    );
  });
});
