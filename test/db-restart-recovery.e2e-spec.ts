/**
 * The database restarts underneath a RUNNING app — the shape the shared
 * SurrealDB upgrade took on 2026-09-09. The container was recreated; the app
 * that was up answered `/ready` with `surrealdb: unreachable` and
 * `scopedPool: unauthorized` for as long as anyone watched (its pool held
 * websockets to a process that no longer existed; the driver reported them
 * connected, gh#618, and every rebuild attempt logged "Sent before
 * connected"), and it came back only when its own container was restarted.
 * A single-replica deploy has no orchestrator to do that for it.
 *
 * So the contract is: after the database comes back, the app recovers on its
 * own — every pool connection is rebuilt on its next use — and the whole
 * surface works again: `/ready`, a scoped read, a root write. No process
 * restart, no operator.
 *
 * Needs the SurrealDB testcontainer's id (test/global-setup.ts exports it);
 * with a preconfigured SURREALDB_URL there is nothing to restart, so the
 * suite is skipped rather than pretending.
 */
import { execFileSync } from 'node:child_process';
import { Surreal } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';

const CONTAINER_ID = process.env.SURREALDB_CONTAINER_ID;
const describeIfContainer = CONTAINER_ID ? describe : describe.skip;

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
      // When the timeout wins, the losing connect can still reject later
      // (on Linux the half-open socket ends in ECONNRESET); an unobserved
      // rejection would fail the test as "read ECONNRESET" with no stack.
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
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`database did not come back within ${timeoutMs} ms: ${lastError}`);
}

describeIfContainer('database restart recovery (real SurrealDB)', () => {
  let f: AppFixture;
  // Every request rides its own connection. supertest re-listens per request
  // and closes its server between requests, which on Node >= 19 also closes
  // idle keep-alive sockets — a request racing onto one of those is a bare
  // "read ECONNRESET" from the client, which is what Linux CI saw after the
  // restart. Unrelated to the database; keep-alive is simply not what this
  // test is about.
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  // Linux CI (and only Linux CI) rejects one request with a bare
  // "read ECONNRESET" after the restart even though every request rides its
  // own connection and the app leaks no error (the capture below stays
  // empty): a transport-level reset between supertest and the in-process
  // server, not the database. Bounded: a request is retried at most three
  // times, each retry is logged, and a persistent reset still fails.
  let resets = 0;
  async function withRetry<T extends { status: number }>(
    label: string,
    send: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await send();
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
        if (!/ECONNRESET/.test(String(code)) || attempt >= 3) throw e;
        resets++;
        console.log(`[restart-e2e] ${label}: ${String(code)} on attempt ${attempt}, retrying`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  // A socket that dies under the app must never surface as an unhandled
  // error: on a production process that is a crash (Node exits on an
  // uncaught exception), and in this test it is exactly the failure that
  // showed on Linux CI as a bare "read ECONNRESET" with no stack. Record
  // every stray error with its stack, and fail on it at the end.
  const stray: string[] = [];
  const onUncaught = (e: unknown) => {
    stray.push(`uncaughtException: ${(e as Error)?.stack ?? String(e)}`);
  };
  const onUnhandled = (e: unknown) => {
    stray.push(`unhandledRejection: ${(e as Error)?.stack ?? String(e)}`);
  };

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    // The fact read surface is behind FACTS_API_ENABLED (default off → 404).
    process.env.FACTS_API_ENABLED = '1';
    f = await createApp({ companyId: 'co_db_restart_e2e' });
  });

  afterAll(async () => {
    delete process.env.FACTS_API_ENABLED;
    if (f) await f.close();
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  });

  async function ingest(object: string): Promise<string> {
    const res = await withRetry('ingest', () =>
      f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .set('Connection', 'close')
        .send({
          entityRef: { vertical: 'rent', id: 'db_restart_subject' },
          predicate: 'claim_probe',
          object,
          validFrom: '2026-01-01',
          confidence: 0.9,
          source: {
            vertical: 'rent',
            recorder: 'bot',
            // Grounded, so the serving gate lets GET /v1/facts/:id return it.
            evidence: [{ kind: 'message', ref: `msg_db_restart_${Date.now()}` }],
          },
        }),
    );
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  }

  it('recovers on its own after the database restarts: /ready, scoped reads and root writes all work again', async () => {
    // Baseline: the surface works before the restart.
    const baseline = await withRetry('/ready', () =>
      f.http.get('/ready').set('Connection', 'close'),
    );
    expect({ status: baseline.status, body: baseline.body }).toMatchObject({ status: 200 });
    const before = await ingest('written before the database restarted');
    const baselineRead = await f.http
      .get(`/v1/facts/${encodeURIComponent(before)}`)
      .set(auth())
      .set('Connection', 'close');
    expect(baselineRead.status).toBe(200);

    // The database goes away and comes back. rocksdb lives inside the
    // container, so schema and rows survive; every websocket does not.
    const t0 = Date.now();
    const stage = (m: string) => console.log(`[restart-e2e +${Date.now() - t0}ms] ${m}`);
    execFileSync('docker', ['restart', CONTAINER_ID!], { stdio: 'ignore' });
    stage('container restarted');
    await waitForDatabase(process.env.SURREALDB_URL!, 60_000);
    stage('database answers a fresh connection');

    // Recovery is on the app's next use of each connection, so /ready may
    // answer 503 once or twice while the pools rebuild; it must converge
    // well inside a minute without anyone restarting the process.
    const deadline = Date.now() + 60_000;
    let ready = await withRetry('/ready', () => f.http.get('/ready').set('Connection', 'close'));
    stage(`first /ready after restart: ${ready.status} ${JSON.stringify(ready.body)}`);
    while (ready.status !== 200 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      ready = await withRetry('/ready', () => f.http.get('/ready').set('Connection', 'close'));
      stage(`/ready: ${ready.status} ${JSON.stringify(ready.body)}`);
    }
    expect({ status: ready.status, body: ready.body }).toMatchObject({
      status: 200,
      body: { ready: true, checks: { surrealdb: 'ok', scopedPool: 'ok' } },
    });

    // Scoped read path (brain_caller pool) — the one that stayed
    // "unauthorized" on the box.
    const read = await withRetry('scoped read', () =>
      f.http
        .get(`/v1/facts/${encodeURIComponent(before)}`)
        .set(auth())
        .set('Connection', 'close'),
    );
    expect(read.status).toBe(200);

    // Root write path.
    const after = await ingest('written after the database restarted');
    expect(
      (
        await f.http
          .get(`/v1/facts/${encodeURIComponent(after)}`)
          .set(auth())
          .set('Connection', 'close')
      ).status,
    ).toBe(200);

    // And the whole pool, not just the first connection /ready happened to
    // take: more reads than there are scoped connections, all served.
    const reads = await Promise.all(
      Array.from({ length: 12 }, () =>
        withRetry('parallel read', () =>
          f.http
            .get(`/v1/facts/${encodeURIComponent(before)}`)
            .set(auth())
            .set('Connection', 'close'),
        ),
      ),
    );
    expect(reads.map((r) => r.status)).toEqual(Array(12).fill(200));

    // Let any late socket error from the dead connections surface, then
    // require that none did.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(stray).toEqual([]);
    expect(resets).toBeLessThanOrEqual(3);
  }, 240_000);
});
