/**
 * RFC 9728 discovery surface: the well-known metadata document and the
 * WWW-Authenticate resource_metadata challenge on 401s — the pair that
 * lets an MCP client find auth.inite.ai and self-onboard.
 */
import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ApiKeyGuard } from '../src/auth/api-key.guard';
import { ProtectedResourceController } from '../src/auth/protected-resource.controller';
import {
  requestBaseUrl,
  resourceMetadataUrl,
  resourcePathSuffix,
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

describe('resourcePathSuffix', () => {
  it('returns the path a resource lives under, and nothing else', () => {
    expect(resourcePathSuffix({ path: '/.well-known/oauth-protected-resource/mcp/co_demo' })).toBe(
      '/mcp/co_demo',
    );
    // Trailing slashes and the bare document both mean "the deployment".
    expect(resourcePathSuffix({ path: '/.well-known/oauth-protected-resource' })).toBe('');
    expect(resourcePathSuffix({ path: '/.well-known/oauth-protected-resource/' })).toBe('');
    // The suffix is echoed inside `resource`, so anything that isn't a
    // plain path is dropped rather than reflected.
    expect(resourcePathSuffix({ path: '/.well-known/oauth-protected-resource/mcp/"evil' })).toBe(
      '',
    );
    expect(resourcePathSuffix({ url: '/.well-known/oauth-protected-resource/mcp/co_x?a=1' })).toBe(
      '/mcp/co_x',
    );
  });
});

describe('ProtectedResourceController', () => {
  const controller = () =>
    new ProtectedResourceController(
      new StubConfig({
        AUTH_SERVICE_ISSUER: 'https://auth.inite.ai',
      }) as unknown as ConfigService,
    );
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'brain.inite.ai' };

  it('advertises the authorization server and the user-delegable scopes', () => {
    const doc = controller().metadata({ headers } as never);
    expect(doc.resource).toBe('https://brain.inite.ai');
    expect(doc.resource_name).toBe('INITE Brain');
    expect(doc.authorization_servers).toEqual(['https://auth.inite.ai']);
    expect(doc.scopes_supported).toContain('brain:read');
    expect(doc.scopes_supported).not.toContain('indexer:write');
    expect(doc.bearer_methods_supported).toEqual(['header']);
    // The landing app serves docs under a language prefix; /docs 404s.
    expect(doc.resource_documentation).toBe('https://brain.inite.ai/en/docs');
  });

  it('answers for a tenant endpoint at the RFC 9728 §3.1 path-suffixed URL', () => {
    const doc = controller().metadataForPath({
      headers,
      path: '/.well-known/oauth-protected-resource/mcp/co_demo',
    } as never);
    expect(doc.resource).toBe('https://brain.inite.ai/mcp/co_demo');
    expect(doc.authorization_servers).toEqual(['https://auth.inite.ai']);
  });
});

/**
 * The path-suffixed route only helps if the router actually binds the
 * pattern — wildcard syntax changed with Express 5, and a bad pattern
 * throws at init rather than at request time. Boot the controller for
 * real and walk both URLs.
 */
describe('ProtectedResourceController — routing', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProtectedResourceController],
      providers: [
        {
          provide: ConfigService,
          useValue: new StubConfig({ AUTH_SERVICE_ISSUER: 'https://auth.inite.ai' }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the deployment document and the per-tenant one', async () => {
    const root = await request(app.getHttpServer())
      .get('/.well-known/oauth-protected-resource')
      .expect(200);
    expect(root.body.resource).toMatch(/^http:\/\/[^/]+$/);
    expect(root.body.authorization_servers).toEqual(['https://auth.inite.ai']);

    const tenant = await request(app.getHttpServer())
      .get('/.well-known/oauth-protected-resource/mcp/co_demo')
      .expect(200);
    // Same document, resource identifier narrowed to the tenant endpoint.
    // (Only the path is compared: supertest binds a fresh ephemeral port
    // per request, so the two hosts legitimately differ.)
    expect(new URL(tenant.body.resource).pathname).toBe('/mcp/co_demo');
    expect(new URL(root.body.resource).pathname).toBe('/');
    expect(tenant.body.authorization_servers).toEqual(['https://auth.inite.ai']);
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
    const guard = new ApiKeyGuard({ resolve: async () => null } as never, new Reflector(), {
      gate: async () => undefined,
    } as never);

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(headersSet['WWW-Authenticate']).toBe(
      'Bearer resource_metadata="https://brain.inite.ai/.well-known/oauth-protected-resource"',
    );
  });
});
