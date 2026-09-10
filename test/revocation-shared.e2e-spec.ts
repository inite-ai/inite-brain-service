/**
 * CAEP revocation shared across replicas, against a REAL SurrealDB.
 *
 * Poll delivery (RFC 8936) is an acked queue: the first replica to poll
 * consumes the SET. With a process-local deny-list the other replicas
 * never learned of it and a revoked session kept working on (N-1)/N of
 * requests until `exp`. Here replica A applies the SET through the real
 * SSF receiver and replica B — a separate RevocationCacheService on a
 * separate connection — denies the subject through the shared
 * `revoked_subject` table (migration 0141), within the coherence bound.
 */
import * as http from 'node:http';
import { ConfigService } from '@nestjs/config';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { SurrealService } from '../src/db/surreal.service';
import { RevocationCacheService } from '../src/auth/revocation-cache.service';
import { SsfReceiverService } from '../src/auth/ssf-receiver.service';

const ISSUER = 'https://auth.test';
const SESSION_REVOKED = 'https://schemas.openid.net/secevent/caep/event-type/session-revoked';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StubConfig {
  constructor(private readonly map: Record<string, string>) {}
  get<T = string>(key: string, fallback?: T): T {
    return (this.map[key] as unknown as T) ?? (fallback as T);
  }
}

describe('CAEP revocation is visible on every replica (real SurrealDB)', () => {
  const savedPool = process.env.SURREALDB_POOL_SIZE;
  const run = Date.now().toString(36);
  let server: http.Server;
  let privateKey: CryptoKey;
  let replicaA: SurrealService;
  let replicaB: SurrealService;
  let denyA: RevocationCacheService;
  let denyB: RevocationCacheService;
  let receiverA: SsfReceiverService;

  const mintSet = (sub: string) =>
    new SignJWT({
      events: { [SESSION_REVOKED]: {} },
      sub_id: { format: 'iss_sub', iss: ISSUER, sub },
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'set-key' })
      .setIssuer(ISSUER)
      .setAudience('brain')
      .setIssuedAt()
      .setJti(`jti-${Math.floor(Math.random() * 1e9)}`)
      .setExpirationTime('5m')
      .sign(privateKey);

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk: JWK = await exportJWK(pair.publicKey);
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    jwk.kid = 'set-key';
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    process.env.SURREALDB_POOL_SIZE = '2';
    replicaA = new SurrealService(new ConfigService());
    await replicaA.onModuleInit();
    replicaB = new SurrealService(new ConfigService());
    await replicaB.onModuleInit();
    denyA = new RevocationCacheService(replicaA);
    denyB = new RevocationCacheService(replicaB);
    receiverA = new SsfReceiverService(
      new StubConfig({
        AUTH_SSF_POLL_URL: `http://127.0.0.1:${port}/poll`,
        AUTH_SERVICE_JWKS_URL: `http://127.0.0.1:${port}/.well-known/jwks.json`,
        AUTH_SERVICE_ISSUER: ISSUER,
        AUTH_SERVICE_URL: `http://127.0.0.1:${port}`,
        AUTH_SSF_CLIENT_ID: 'brain-service',
        AUTH_SSF_CLIENT_SECRET: 's3cret',
      }) as unknown as ConfigService,
      denyA,
    );
    receiverA.onModuleInit();
  }, 120_000);

  afterAll(async () => {
    receiverA?.onModuleDestroy();
    await replicaA?.onApplicationShutdown();
    await replicaB?.onApplicationShutdown();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (savedPool === undefined) delete process.env.SURREALDB_POOL_SIZE;
    else process.env.SURREALDB_POOL_SIZE = savedPool;
  });

  const pendingAcks = () => (receiverA as unknown as { pendingAcks: string[] }).pendingAcks;

  it('a SET polled on replica A denies the subject on replica B', async () => {
    const sub = `did:key:z6MkA-${run}`;
    await receiverA.applySet('jti-shared', await mintSet(sub));
    expect(pendingAcks()).toContain('jti-shared');
    expect(denyA.isDeniedLocally(sub)).toBe(true);
    // Replica B has never heard of this subject; its read-through pulls.
    expect(await denyB.isDenied(sub)).toBe(true);
    expect(denyB.isDeniedLocally(sub)).toBe(true);
  });

  it('a subject denied after a replica last pulled is denied there within the coherence bound', async () => {
    // Replica B pulled a moment ago (previous test) — make that explicit.
    await denyB.isDenied('warm-up');
    const sub = `did:key:z6MkLater-${run}`;
    await denyA.deny(sub, 60_000, SESSION_REVOKED);
    await sleep(5_100);
    expect(await denyB.isDenied(sub)).toBe(true);
  });

  it('an already-expired denial is not shared, and a short one lapses everywhere', async () => {
    const gone = `did:key:z6MkGone-${run}`;
    await denyA.deny(gone, -1);
    await denyB.refresh();
    expect(denyB.isDeniedLocally(gone)).toBe(false);

    const brief = `did:key:z6MkBrief-${run}`;
    await denyA.deny(brief, 500);
    await sleep(700);
    const fresh = new RevocationCacheService(replicaB);
    expect(await fresh.isDenied(brief)).toBe(false);
  });

  it('sweepExpired removes lapsed denials and keeps live ones', async () => {
    const lapsed = `did:key:z6MkSwept-${run}`;
    const live = `did:key:z6MkKept-${run}`;
    await denyA.deny(lapsed, 400);
    await denyA.deny(live, 60_000);
    await sleep(600);
    expect(await denyB.sweepExpired()).toBeGreaterThanOrEqual(1);
    const remaining = await replicaB.withAdminDb(async (db) => {
      const [rows] = await db.query<[Array<{ subject: string }>]>(
        `SELECT subject FROM revoked_subject WHERE subject IN [$lapsed, $live]`,
        { lapsed, live },
      );
      return ((rows as Array<{ subject: string }> | undefined) ?? []).map((r) => r.subject);
    });
    expect(remaining).toContain(live);
    expect(remaining).not.toContain(lapsed);
  });

  it('the shared row records the revoking event as the reason', async () => {
    const sub = `did:key:z6MkReason-${run}`;
    await receiverA.applySet('jti-reason', await mintSet(sub));
    const row = await replicaB.withAdminDb(async (db) => {
      const [rows] = await db.query<[Array<{ reason?: string; expiresAt: unknown }>]>(
        `SELECT reason, expiresAt FROM type::record('revoked_subject', $sub)`,
        { sub },
      );
      return (rows as Array<{ reason?: string; expiresAt: unknown }> | undefined)?.[0];
    });
    expect(row?.reason).toBe(SESSION_REVOKED);
    expect(row?.expiresAt).toBeDefined();
  });

  it('serves the local deny-list, logged, when the shared table cannot be read', async () => {
    const dead = {
      withAdminDb: async () => {
        throw new Error('system db unreachable');
      },
    } as unknown as SurrealService;
    const isolated = new RevocationCacheService(dead);
    await expect(isolated.deny('sub-x', 60_000)).rejects.toThrow('system db unreachable');
    // Denied locally even though the shared write failed…
    expect(isolated.isDeniedLocally('sub-x')).toBe(true);
    // …and isDenied still answers from the local map through the failed pull.
    expect(await isolated.isDenied('sub-x')).toBe(true);
    expect(await isolated.isDenied('sub-y')).toBe(false);
  });
});
