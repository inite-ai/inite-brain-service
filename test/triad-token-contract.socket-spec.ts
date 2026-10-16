/**
 * INITE Triad token contract — conformance of brain's verifier against
 * tokens shaped EXACTLY as the auth-service mints them.
 *
 * The claim shapes below are copied from inite-auth-service:
 *   - user flows (authorization_code / refresh / device_code):
 *     src/oauth/oauth-token-issuer.service.ts → buildAccessToken
 *   - client_credentials (M2M): src/oauth/oauth-m2m.service.ts →
 *     issueClientCredentialsToken
 *   - token exchange (RFC 8693): oauth-m2m.service.ts → exchangeToken
 * signed RS256 with `kid` in the header, served by a stub JWKS. The
 * contract itself: inite-ecosystem/docs/triad-compatibility.md.
 */
import * as http from 'node:http';
import { ConfigService } from '@nestjs/config';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { mapIntrospectionRecord } from '../src/auth/introspection.client';
import { JwksService } from '../src/auth/jwks.service';
import { RevocationCacheService } from '../src/auth/revocation-cache.service';

const ISSUER = 'https://auth-api.triad.test';
const BRAIN_URL = 'https://brain.triad.test';
const KID = 'auth-rs256-key-1';
const USER_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const COMPANY = 'co_acme';

class StubConfig {
  constructor(private readonly map: Record<string, string>) {}
  get<T = string>(key: string, fallback?: T): T {
    return (this.map[key] as unknown as T) ?? (fallback as T);
  }
}

/** buildAccessToken in the auth-service, with RBAC_TOKEN_CLAIMS_ENABLED on. */
function userAccessClaims(scope: string, withOrg = true): Record<string, unknown> {
  return {
    sub: USER_DID,
    client_id: 'dcr_0123456789abcdef0123456789abcdef',
    userId: '5f0c7a8e-3b7e-4d0a-9c55-2d3f1f6b9e10',
    email: 'ana@example.com',
    email_verified: true,
    name: 'Ana',
    picture: null,
    roles: ['user', 'owner'],
    ...(withOrg ? { org: COMPANY, org_id: '9a1b2c3d-0000-4000-8000-000000000001' } : {}),
    scope,
  };
}

/** issueClientCredentialsToken: sub = client.companyId ?? clientId. */
function m2mClaims(scopes: string[]): Record<string, unknown> {
  return { sub: COMPANY, client_id: 'acme-backend', scopes, scope: scopes.join(' ') };
}

describe('Triad token contract — brain verifier', () => {
  let server: http.Server;
  let jwksUrl: string;
  let privateKey: CryptoKey;

  function mint(
    claims: Record<string, unknown>,
    opts: { aud: string | string[]; iss?: string; exp?: string },
  ): Promise<string> {
    // jsonwebtoken (what @nestjs/jwt uses) writes typ: JWT next to alg/kid.
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
      .setIssuedAt()
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud)
      .setExpirationTime(opts.exp ?? '10m')
      .sign(privateKey);
  }

  function verifier(env: Record<string, string> = {}): JwksService {
    const config = new StubConfig({
      AUTH_SERVICE_JWKS_URL: jwksUrl,
      AUTH_SERVICE_ISSUER: ISSUER,
      AUTH_SERVICE_AUDIENCE: 'brain',
      BRAIN_PUBLIC_URL: BRAIN_URL,
      ...env,
    }) as unknown as ConfigService;
    const svc = new JwksService(config, new RevocationCacheService());
    svc.onModuleInit();
    return svc;
  }

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', use: 'sig', kid: KID };
    server = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as { port: number };
    jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe('accepted, with the right tenant / user / scope', () => {
    it('an MCP connector token (authorization_code, aud = <brain>/mcp)', async () => {
      const token = await mint(userAccessClaims('openid profile brain:read brain:write'), {
        aud: `${BRAIN_URL}/mcp`,
      });
      const rec = await verifier().verify(token);
      expect(rec).toMatchObject({
        companyId: COMPANY,
        userId: USER_DID,
        scopes: ['brain:read', 'brain:write'],
        actorId: 'dcr_0123456789abcdef0123456789abcdef',
      });
    });

    it('the same token after refresh rotation (audience kept, auth #217)', async () => {
      // Rotation re-runs buildAccessToken with the persisted resource.
      const token = await mint(userAccessClaims('brain:read'), { aud: `${BRAIN_URL}/mcp` });
      expect(await verifier().verify(token)).toMatchObject({
        companyId: COMPANY,
        scopes: ['brain:read'],
      });
    });

    it('a token bound to the deployment URL (resource = <brain>)', async () => {
      const token = await mint(userAccessClaims('brain:read'), { aud: BRAIN_URL });
      expect(await verifier().verify(token)).toMatchObject({
        companyId: COMPANY,
        userId: USER_DID,
      });
    });

    it('a token bound to the per-tenant resource <brain>/mcp/<its own org>', async () => {
      // /.well-known/oauth-protected-resource/mcp/<companyId> advertises it.
      const token = await mint(userAccessClaims('brain:read'), {
        aud: `${BRAIN_URL}/mcp/${COMPANY}`,
      });
      expect(await verifier().verify(token)).toMatchObject({ companyId: COMPANY });
    });

    it('an M2M client_credentials token (no org: tenant = sub, scopes array)', async () => {
      const token = await mint(m2mClaims(['brain:read', 'brain:write', 'indexer:write']), {
        aud: 'brain',
        exp: '5m',
      });
      const rec = await verifier().verify(token);
      expect(rec).toMatchObject({ companyId: COMPANY, scopes: ['brain:read', 'brain:write'] });
      expect(rec?.userId).toBeUndefined();
    });

    it('a token-exchange token (act names the agent, org/roles carried over)', async () => {
      const token = await mint(
        {
          sub: USER_DID,
          client_id: 'acme-bff',
          act: { sub: 'acme-bff' },
          scopes: ['brain:read'],
          scope: 'brain:read',
          org: COMPANY,
          org_id: '9a1b2c3d-0000-4000-8000-000000000001',
          roles: ['user'],
        },
        { aud: 'brain', exp: '5m' },
      );
      expect(await verifier().verify(token)).toMatchObject({
        companyId: COMPANY,
        userId: USER_DID,
        actorId: 'acme-bff',
      });
    });

    it('an issuer configured with a trailing slash matches the signed iss', async () => {
      const token = await mint(userAccessClaims('brain:read'), { aud: 'brain' });
      expect(await verifier({ AUTH_SERVICE_ISSUER: `${ISSUER}/` }).verify(token)).not.toBeNull();
    });

    it('an issuer migration: old and new issuer both accepted from a list', async () => {
      const svc = verifier({ AUTH_SERVICE_ISSUER: `https://auth.old.test,${ISSUER}` });
      const fresh = await mint(userAccessClaims('brain:read'), { aud: 'brain' });
      const old = await mint(userAccessClaims('brain:read'), {
        aud: 'brain',
        iss: 'https://auth.old.test',
      });
      expect(await svc.verify(fresh)).not.toBeNull();
      expect(await svc.verify(old)).not.toBeNull();
    });
  });

  describe('rejected', () => {
    it('a wrong issuer', async () => {
      const token = await mint(userAccessClaims('brain:read'), {
        aud: `${BRAIN_URL}/mcp`,
        iss: 'https://evil.test',
      });
      expect(await verifier().verify(token)).toBeNull();
    });

    it('the JWKS host instead of the real issuer (auth.* vs auth-api.*)', async () => {
      const token = await mint(userAccessClaims('brain:read'), { aud: 'brain' });
      expect(
        await verifier({ AUTH_SERVICE_ISSUER: 'https://auth.triad.test' }).verify(token),
      ).toBeNull();
    });

    it("a token for another resource (billing's MCP)", async () => {
      const token = await mint(userAccessClaims('brain:read billing:account'), {
        aud: 'https://billing.triad.test/mcp',
      });
      expect(await verifier().verify(token)).toBeNull();
    });

    it('a token bound to ANOTHER tenant’s per-tenant resource', async () => {
      const token = await mint(userAccessClaims('brain:read'), {
        aud: `${BRAIN_URL}/mcp/co_other`,
      });
      expect(await verifier().verify(token)).toBeNull();
    });

    it('an id_token-shaped audience (the client id) — not a brain audience', async () => {
      const token = await mint(userAccessClaims('brain:read'), {
        aud: 'dcr_0123456789abcdef0123456789abcdef',
      });
      expect(await verifier().verify(token)).toBeNull();
    });

    it('a user token without org (auth RBAC_TOKEN_CLAIMS_ENABLED off): a DID is not a tenant', async () => {
      const token = await mint(userAccessClaims('brain:read', false), { aud: `${BRAIN_URL}/mcp` });
      expect(await verifier().verify(token)).toBeNull();
    });

    it('a token with no brain scope', async () => {
      const token = await mint(userAccessClaims('openid billing:account'), {
        aud: `${BRAIN_URL}/mcp`,
      });
      expect(await verifier().verify(token)).toBeNull();
    });
  });

  describe('introspection answers the same audience set', () => {
    // auth ApiKeysService.introspect: sub = owner DID ?? companyId, org, aud = key.audience.
    const answer = (aud: string) => ({
      active: true,
      sub: USER_DID,
      org: COMPANY,
      org_id: '9a1b2c3d-0000-4000-8000-000000000001',
      aud,
      client_id: aud,
      scope: 'brain:read',
    });
    const accepted = ['brain', BRAIN_URL, `${BRAIN_URL}/mcp`];

    it('accepts a key for any accepted audience', () => {
      expect(mapIntrospectionRecord(answer('brain'), 'h', accepted)).toMatchObject({
        companyId: COMPANY,
        userId: USER_DID,
      });
      expect(mapIntrospectionRecord(answer(`${BRAIN_URL}/mcp`), 'h', accepted)).not.toBeNull();
    });

    it('rejects a key minted for another vertical', () => {
      expect(mapIntrospectionRecord(answer('inite-billing'), 'h', accepted)).toBeNull();
    });
  });
});
