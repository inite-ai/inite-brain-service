/**
 * A LIVE subscription outlives a database outage — against a REAL SurrealDB
 * (testcontainers, v3.2.4, started by test/global-setup.ts on a FIXED host
 * port so the database comes back on the same URL, as a compose service does).
 *
 * THE CONTRACT. The subscription connection is handed out to nobody, so it
 * never passes through `ensureSession` the way every pooled connection does on
 * acquire. Its own repair point is the catch-up tick: probe the connection,
 * re-sign the session, re-issue the LIVE query, replay the changefeed from the
 * cursor it kept. A subscriber must therefore see a fact written after the
 * outage WITHOUT a process restart, and the standing LIVE query must be
 * working again afterwards — not a changefeed-only half-life at tick latency.
 *
 * What this spec is and is not. Measured on 3.2.4 with surrealdb-js 2.0.8:
 * the driver's own reconnect does eventually restore the session and restart
 * its managed subscriptions, so the naive tick recovers too — about 10 s
 * later (the in-flight catch-up burns its whole timeout first), and only
 * because of the driver. This spec is the end-to-end guard on the contract;
 * the per-state proof (a session that comes back anonymous while the keeper
 * still holds a valid expiry, a LIVE query the driver could not restart, a
 * rebuild that cannot connect) is in test/live-subscription.unit-spec.ts,
 * where each of those fails without the fix.
 *
 * With a preconfigured SURREALDB_URL there is no container to restart, so the
 * suite skips rather than pretending.
 */
import { execFileSync } from 'node:child_process';
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';
import { LiveSubscriptionManager } from '../src/live/live-subscription.manager';

const CONTAINER_ID = process.env.SURREALDB_CONTAINER_ID;
const describeIfContainer = CONTAINER_ID ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Outage length: past the driver's reconnect budget (5 attempts, backing off). */
const OUTAGE_MS = 45_000;

/** Poll until the database answers a fresh connection again. */
async function waitForDatabase(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    const probe = new Surreal();
    try {
      // The published port answers TCP the moment the container is up
      // (docker-proxy), before the server accepts websockets — an unbounded
      // connect() hangs there, so every attempt is bounded.
      const attempt = probe.connect(url).then(() => probe.version());
      attempt.catch(() => undefined);
      await Promise.race([
        attempt,
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 3_000)),
      ]);
      await probe.close().catch(() => undefined);
      return;
    } catch (e) {
      lastError = (e as Error).message;
      await probe.close().catch(() => undefined);
      await sleep(250);
    }
  }
  throw new Error(`database did not come back within ${timeoutMs} ms: ${lastError}`);
}

describeIfContainer('LIVE subscription recovery across a database restart', () => {
  const tenant = `liverst${Date.now().toString(36)}`;
  const saved: Record<string, string | undefined> = {};
  let svc: SurrealService;
  let mgr: LiveSubscriptionManager;
  let entityId: unknown;

  const setEnv = (key: string, value: string) => {
    saved[key] = process.env[key];
    process.env[key] = value;
  };

  beforeAll(async () => {
    setEnv('LIVE_SUBSCRIPTIONS_ENABLED', '1');
    // The tick is the recovery point, so let it run on a short interval
    // instead of making the test wait out the 10 s production default.
    setEnv('LIVE_CATCHUP_INTERVAL_MS', '1000');
    svc = new SurrealService(new ConfigService());
    await svc.onModuleInit();
    // First touch creates and migrates the tenant database (knowledge_fact
    // carries the CHANGEFEED the catch-up leg reads).
    entityId = await svc.withCompany(tenant, async (db) => {
      const [ents] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity SET type = 'other', canonicalName = 'restart probe'`,
      );
      return (ents as Array<{ id: unknown }>)[0]!.id;
    });
    mgr = new LiveSubscriptionManager(new ConfigService());
  }, 120_000);

  afterAll(async () => {
    if (mgr) await mgr.onApplicationShutdown();
    if (svc) await svc.onApplicationShutdown();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const createFact = (object: string) =>
    svc.withCompany(tenant, (db) =>
      db.query(
        `CREATE knowledge_fact SET entityId = $e, predicate = 'restart_probe', object = $o,
           confidence = 0.9, validFrom = time::now(),
           source = { vertical: 'rent', eventId: 'restart.probe' }`,
        { e: entityId, o: object },
      ),
    );

  /** Wait for a condition the subscription is supposed to reach on its own. */
  async function waitUntil(what: string, ok: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (ok()) return;
      await sleep(250);
    }
    throw new Error(`${what} did not happen within ${timeoutMs} ms`);
  }

  it('delivers a fact written after the database restarted, with no process restart', async () => {
    const events: Array<{ object: string; via: string }> = [];
    const received: string[] = [];
    const handle = await mgr.subscribe(tenant, {
      callerScopes: ['brain:read'],
      sink: (e) => {
        if (e.kind !== 'fact') return;
        events.push({ object: e.object, via: e.via });
        received.push(e.object);
      },
    });
    try {
      // Baseline: the channel works before the outage.
      await createFact('before-restart');
      await waitUntil('before-restart delivery', () => received.includes('before-restart'), 20_000);

      // The database goes away and comes back on the same URL. rocksdb lives
      // inside the container, so schema and rows survive; every websocket
      // (the subscription's included) does not.
      const t0 = Date.now();
      const stage = (m: string) => console.log(`[live-restart-e2e +${Date.now() - t0}ms] ${m}`);
      // Down for longer than the driver's own reconnect budget (5 attempts),
      // which is what a real upgrade or a partition looks like: by the time
      // the database is back, nothing is going to restore the socket, the
      // session or the LIVE query for us.
      execFileSync('docker', ['stop', CONTAINER_ID!], { stdio: 'ignore' });
      stage('container stopped');
      await sleep(OUTAGE_MS);
      execFileSync('docker', ['start', CONTAINER_ID!], { stdio: 'ignore' });
      stage('container started again');
      await waitForDatabase(process.env.SURREALDB_URL!, 60_000);
      stage('database answers a fresh connection');

      // The write path recovers on its own (pool ensureSession), so this is
      // purely about the subscription seeing what was written.
      await createFact('after-restart');
      stage('fact written after the restart');
      await waitUntil('after-restart delivery', () => received.includes('after-restart'), 90_000);
      stage('subscriber received the post-restart fact');

      // And the channel is whole again, not limping on the changefeed alone:
      // the next write arrives over the STANDING LIVE QUERY. Without the
      // rebuild the socket's subscription stays dead for the life of the
      // process and every event is a replay, at tick latency.
      await createFact('after-recovery');
      await waitUntil(
        'after-recovery delivery over LIVE',
        () => events.some((e) => e.object === 'after-recovery' && e.via === 'live'),
        30_000,
      );
      stage('post-recovery fact arrived over the rebuilt LIVE query');
      await expect(mgr.catchUp(tenant)).resolves.toBeGreaterThanOrEqual(0);
    } finally {
      await handle.close();
    }
  }, 300_000);
});
