/**
 * SSF receiver — CAEP SET handling against a locally-minted key pair.
 * Covers: a signed session-revoked SET deny-lists its subject and is
 * acked; a non-revoking event type is acked without denying; a SET with
 * a bad signature is acked (never redelivered) but not trusted.
 */
import * as http from 'node:http';
import { ConfigService } from '@nestjs/config';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { RevocationCacheService } from '../src/auth/revocation-cache.service';
import { SsfReceiverService } from '../src/auth/ssf-receiver.service';

const ISSUER = 'https://auth.test';
const SESSION_REVOKED =
  'https://schemas.openid.net/secevent/caep/event-type/session-revoked';
const VERIFICATION =
  'https://schemas.openid.net/secevent/ssf/event-type/verification';

class StubConfig {
  constructor(private readonly map: Record<string, string>) {}
  get<T = string>(key: string, fallback?: T): T {
    return (this.map[key] as unknown as T) ?? (fallback as T);
  }
}

describe('SsfReceiverService.applySet', () => {
  let server: http.Server;
  let privateKey: KeyLike;
  let receiver: SsfReceiverService;
  let revocations: RevocationCacheService;

  function mintSet(events: Record<string, unknown>, sub: string, key?: KeyLike) {
    return new SignJWT({ events, sub_id: { format: 'iss_sub', iss: ISSUER, sub } })
      .setProtectedHeader({ alg: 'RS256', kid: 'set-key' })
      .setIssuer(ISSUER)
      .setAudience('brain')
      .setIssuedAt()
      .setJti(`jti-${Math.floor(Math.random() * 1e9)}`)
      .setExpirationTime('5m')
      .sign(key ?? privateKey);
  }

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk: JWK = await exportJWK(pair.publicKey);
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    jwk.kid = 'set-key';

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    revocations = new RevocationCacheService();
    receiver = new SsfReceiverService(
      new StubConfig({
        AUTH_SSF_POLL_URL: `http://127.0.0.1:${port}/poll`,
        AUTH_SERVICE_JWKS_URL: `http://127.0.0.1:${port}/.well-known/jwks.json`,
        AUTH_SERVICE_ISSUER: ISSUER,
        AUTH_SERVICE_URL: `http://127.0.0.1:${port}`,
        AUTH_SSF_CLIENT_ID: 'brain-service',
        AUTH_SSF_CLIENT_SECRET: 's3cret',
      }) as unknown as ConfigService,
      revocations,
    );
    receiver.onModuleInit();
  });

  afterAll(async () => {
    receiver.onModuleDestroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('deny-lists the subject of a session-revoked SET', async () => {
    const set = await mintSet({ [SESSION_REVOKED]: {} }, 'did:key:z6MkRevoked');
    await receiver.applySet('jti-1', set);
    expect(revocations.isDenied('did:key:z6MkRevoked')).toBe(true);
  });

  it('ignores (but acks) non-revoking event types', async () => {
    const set = await mintSet({ [VERIFICATION]: {} }, 'did:key:z6MkFine');
    await receiver.applySet('jti-2', set);
    expect(revocations.isDenied('did:key:z6MkFine')).toBe(false);
  });

  it('never trusts a SET with a foreign signature', async () => {
    const { privateKey: foreign } = await generateKeyPair('RS256', {
      extractable: true,
    });
    const set = await mintSet({ [SESSION_REVOKED]: {} }, 'did:key:z6MkForged', foreign);
    await receiver.applySet('jti-3', set);
    expect(revocations.isDenied('did:key:z6MkForged')).toBe(false);
  });
});

describe('RevocationCacheService', () => {
  it('expires entries after their TTL', () => {
    const cache = new RevocationCacheService();
    cache.deny('sub-1', -1);
    expect(cache.isDenied('sub-1')).toBe(false);
    cache.deny('sub-2', 60_000);
    expect(cache.isDenied('sub-2')).toBe(true);
  });
});
