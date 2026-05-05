/**
 * Unit-test for ApiKeyGuard's JWT verification path.
 *
 * Verifies the guard against a locally-served JWKS and a manually-minted
 * JWT, without spawning the full HTTP service or touching SurrealDB. This
 * is the right shape for the auth surface — pure validation logic, no IO.
 *
 * Static-key fallback is also covered.
 */
import * as http from 'node:http';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { ApiKeyGuard } from '../src/auth/api-key.guard';
import { ApiKeyService } from '../src/auth/api-key.service';
import { JwksService } from '../src/auth/jwks.service';

const ISSUER = 'https://auth.test';
const AUDIENCE = 'brain';

function makeMockContext(headers: Record<string, string>) {
  const req: { headers: Record<string, string>; brainAuth?: unknown } = { headers };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

class StubConfig {
  constructor(private readonly map: Record<string, string>) {}
  get<T = string>(key: string, fallback?: T): T {
    return (this.map[key] as unknown as T) ?? (fallback as T);
  }
  getOrThrow<T = string>(key: string): T {
    const v = this.map[key];
    if (v === undefined) throw new Error(`missing ${key}`);
    return v as unknown as T;
  }
}

describe('ApiKeyGuard — JWKS verification', () => {
  let jwksServer: http.Server;
  let jwksUrl: string;
  let publicJwk: JWK;
  let privateKey: KeyLike;
  let guard: ApiKeyGuard;
  let jwks: JwksService;
  let apiKeys: ApiKeyService;

  function mintJwt(opts: {
    sub: string;
    scopes?: string[];
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    signWith?: KeyLike;
  }): Promise<string> {
    return new SignJWT({ scopes: opts.scopes ?? ['brain:read', 'brain:write'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setSubject(opts.sub)
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '5m')
      .sign(opts.signWith ?? privateKey);
  }

  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair('RS256', {
      extractable: true,
    });
    privateKey = priv;
    publicJwk = await exportJWK(publicKey);
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    publicJwk.kid = 'test-key-1';

    jwksServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [publicJwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', () => r()));
    const port = (jwksServer.address() as { port: number }).port;
    jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`;

    const config = new StubConfig({
      AUTH_SERVICE_JWKS_URL: jwksUrl,
      AUTH_SERVICE_ISSUER: ISSUER,
      AUTH_SERVICE_AUDIENCE: AUDIENCE,
      BRAIN_API_KEYS: JSON.stringify([
        {
          keyHash:
            'sha256:' +
            require('node:crypto')
              .createHash('sha256')
              .update('static-test-key')
              .digest('hex'),
          companyId: 'co_static',
          scopes: ['brain:read', 'brain:write'],
        },
      ]),
      NODE_ENV: 'test',
    });

    jwks = new JwksService(config as unknown as ConfigService);
    jwks.onModuleInit();

    apiKeys = new ApiKeyService(config as unknown as ConfigService);
    apiKeys.onModuleInit();

    guard = new ApiKeyGuard(
      apiKeys,
      jwks,
      new Reflector(),
      config as unknown as ConfigService,
    );
  });

  afterAll(async () => {
    if (jwksServer) {
      await new Promise<void>((r) => jwksServer.close(() => r()));
    }
  });

  it('accepts a valid JWT and stamps companyId from sub', async () => {
    const token = await mintJwt({ sub: 'jwt_co_alpha' });
    const { ctx, req } = makeMockContext({ authorization: `Bearer ${token}` });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect((req.brainAuth as { companyId: string }).companyId).toBe('jwt_co_alpha');
    expect((req.brainAuth as { keyHash: string }).keyHash).toMatch(/^jwt:/);
  });

  it('rejects expired JWT (401)', async () => {
    const expired = await mintJwt({ sub: 'jwt_co_x', expiresIn: 0 });
    await new Promise((r) => setTimeout(r, 1100));
    const { ctx } = makeMockContext({ authorization: `Bearer ${expired}` });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects JWT signed by an unknown key (401)', async () => {
    const { privateKey: bad } = await generateKeyPair('RS256', { extractable: true });
    const token = await mintJwt({ sub: 'jwt_evil', signWith: bad });
    const { ctx } = makeMockContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects JWT with wrong audience (401)', async () => {
    const token = await mintJwt({ sub: 'jwt_co_x', audience: 'wrong' });
    const { ctx } = makeMockContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects JWT with wrong issuer (401)', async () => {
    const token = await mintJwt({ sub: 'jwt_co_x', issuer: 'https://evil.test' });
    const { ctx } = makeMockContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('falls back to static API key when token is not a JWT', async () => {
    const { ctx, req } = makeMockContext({ authorization: 'Bearer static-test-key' });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect((req.brainAuth as { companyId: string }).companyId).toBe('co_static');
  });

  it('rejects missing Authorization header (401)', async () => {
    const { ctx } = makeMockContext({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ApiKeyGuard — production with JWKS rejects static keys', () => {
  let jwksServer: http.Server;
  let jwks: JwksService;
  let guard: ApiKeyGuard;
  let apiKeys: ApiKeyService;

  beforeAll(async () => {
    const { publicKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    jwk.kid = 'prod-key';

    jwksServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', () => r()));
    const port = (jwksServer.address() as { port: number }).port;

    const config = new StubConfig({
      AUTH_SERVICE_JWKS_URL: `http://127.0.0.1:${port}/.well-known/jwks.json`,
      BRAIN_API_KEYS: JSON.stringify([
        {
          keyHash:
            'sha256:' +
            require('node:crypto')
              .createHash('sha256')
              .update('prod-static-key')
              .digest('hex'),
          companyId: 'co_prod',
          scopes: ['brain:read'],
        },
      ]),
      NODE_ENV: 'production',
    });

    jwks = new JwksService(config as unknown as ConfigService);
    jwks.onModuleInit();
    apiKeys = new ApiKeyService(config as unknown as ConfigService);
    apiKeys.onModuleInit();
    guard = new ApiKeyGuard(
      apiKeys,
      jwks,
      new Reflector(),
      config as unknown as ConfigService,
    );
  });

  afterAll(async () => {
    if (jwksServer) await new Promise<void>((r) => jwksServer.close(() => r()));
  });

  it('static key is rejected in production with JWKS enabled', async () => {
    const { ctx } = makeMockContext({ authorization: 'Bearer prod-static-key' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
