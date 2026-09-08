/**
 * Scoped-pool session expiry (audit 2026-09-08 P0) — against a REAL
 * SurrealDB (testcontainers, v3.2.4, started by test/global-setup.ts).
 *
 * THE DEFECT. surrealdb-js 2.0.8 renews only the sessions it opened itself.
 * `db.signin()` from application code sets `authOverriden`, and the driver's
 * renewal timer then has nothing to renew with: at `exp - 60s` it calls
 * `invalidate()` and the connection goes ANONYMOUS for the rest of the
 * process. The root pool never showed this because it re-signs on every
 * acquire; the scoped pool signed in exactly once, at boot, so ~59 minutes
 * after start every caller-facing read — search, entity reads, fact reads,
 * stats, artifacts — answered "Anonymous access not allowed" while writes,
 * /health and /ready stayed green.
 *
 * HOW THIS TEST DRIVES IT IN SECONDS. Not by mocking `Date.now()` — that
 * poisons the session state and produces a false positive (learned in #481).
 * Instead the DB user is provisioned with a real, very short token lifetime
 * (`SURREALDB_SCOPED_TOKEN_DURATION=5s`), so the identical code path runs on
 * a compressed clock: the token really is issued with a 5-second `exp`, the
 * driver really does fire its timer, and the wait is wall-clock.
 */
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';

const SCOPED_USER = 'brain_caller';
const SCOPED_PASS = 'scoped-session-expiry-spec';
/** Token lifetime brain provisions the scoped user with, for this spec. */
const TOKEN_DURATION = '5s';
/** Comfortably past `exp` (and past the driver's invalidate timer). */
const PAST_EXPIRY_MS = 9_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The cheapest authorization-gated statement SurrealDB has. */
const readOne = (db: Surreal) => db.query<[number]>('RETURN 1');
const ANONYMOUS = /Anonymous access not allowed/i;

describe('Scoped pool — session expiry', () => {
  const tenant = `sesexp${Date.now().toString(36)}`;
  const saved: Record<string, string | undefined> = {};
  let url: string;
  let namespace: string;
  let root: Surreal;
  let svc: SurrealService;

  const setEnv = (key: string, value: string) => {
    saved[key] = process.env[key];
    process.env[key] = value;
  };

  beforeAll(async () => {
    url = process.env.SURREALDB_URL!;
    namespace = process.env.SURREALDB_NAMESPACE ?? 'brain';

    root = new Surreal();
    await root.connect(url);
    await root.signin({
      username: process.env.SURREALDB_USERNAME!,
      password: process.env.SURREALDB_PASSWORD!,
    });
    await root.query(`DEFINE NAMESPACE IF NOT EXISTS \`${namespace}\``);
    await root.use({ namespace });

    setEnv('SURREALDB_SCOPED_USER', SCOPED_USER);
    setEnv('SURREALDB_SCOPED_PASS', SCOPED_PASS);
    setEnv('SURREALDB_SCOPED_TOKEN_DURATION', TOKEN_DURATION);
    setEnv('SURREALDB_POOL_SIZE', '2');
    setEnv('SURREALDB_SCOPED_POOL_SIZE', '2');

    svc = new SurrealService(new ConfigService());
    await svc.onModuleInit();
    // Migrations run through a ROOT path first — same as app bootstrap. This
    // is where migration 0005 defines `brain_caller`, where brain then
    // (re)provisions it with the declared short token lifetime, and where the
    // idle scoped connections are re-signed. From here the pool holds
    // 5-second tokens.
    await svc.withCompany(tenant, (db) => readOne(db));
    await svc.withScopedCompany(tenant, ['brain:read'], (db) => readOne(db));
  }, 180_000);

  afterAll(async () => {
    await svc?.onApplicationShutdown();
    // Put the shared container's scoped user back on the server default so
    // later specs in this worker are not left signing in every read.
    await root
      ?.query(
        `DEFINE USER OVERWRITE ${SCOPED_USER} ON NAMESPACE PASSWORD '${SCOPED_PASS}' ROLES EDITOR`,
      )
      .catch(() => undefined);
    await root?.close().catch(() => undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('provisions the scoped user with the declared token lifetime', async () => {
    const probe = new Surreal();
    await probe.connect(url);
    const tokens = await probe.signin({
      username: SCOPED_USER,
      password: SCOPED_PASS,
      namespace,
    });
    const claims = JSON.parse(
      Buffer.from(tokens.access.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(5);
    await probe.close();
  });

  it('DEFECT: a connection signed in ONCE goes anonymous when its token lapses', async () => {
    // This is the pre-fix scoped pool, reproduced verbatim: connect, signin,
    // use, then serve reads from it forever.
    const stuck = new Surreal();
    await stuck.connect(url);
    await stuck.signin({ username: SCOPED_USER, password: SCOPED_PASS, namespace });
    await stuck.use({ namespace, database: `co_${tenant}` });
    await expect(stuck.query('RETURN 1')).resolves.toBeDefined();

    await sleep(PAST_EXPIRY_MS);

    // The socket is still open and the server never dropped the connection —
    // the driver invalidated the session on its own.
    await expect(stuck.query('RETURN 1')).rejects.toThrow(ANONYMOUS);
    // …and it stays broken. No retry heals it; only a new signin does.
    await expect(stuck.query('RETURN 1')).rejects.toThrow(ANONYMOUS);

    // The health probe brain used to rely on is BLIND to this: `version()`
    // is answered for an anonymous session too, which is why /health and
    // /ready reported "ok" throughout the outage.
    await expect(stuck.version()).resolves.toBeDefined();

    await stuck.close();
  }, 60_000);

  it('FIX: the scoped pool keeps serving reads across the same lapse', async () => {
    await sleep(PAST_EXPIRY_MS);
    const first = await svc.withScopedCompany(tenant, ['brain:read'], (db) => readOne(db));
    expect(first).toEqual([1]);

    // Not a one-shot heal — the pool must survive every subsequent lapse.
    await sleep(PAST_EXPIRY_MS);
    const second = await svc.withScopedCompany(tenant, ['brain:read'], (db) => readOne(db));
    expect(second).toEqual([1]);
  }, 90_000);

  it('FIX: readiness exercises the scoped read path, not just the socket', async () => {
    await sleep(PAST_EXPIRY_MS);
    // `ping()` only proves the socket answers — it did so throughout the
    // outage. `pingScoped()` runs an authorization-gated statement on a
    // scoped connection, so it can actually observe the read path.
    await expect(svc.ping()).resolves.toBe(true);
    await expect(svc.pingScoped()).resolves.toBe(true);
  }, 60_000);

  it('FIX: the pool returns connections that are still scoped, not root', async () => {
    // Renewal must not quietly widen privilege. `$auth` is NONE for a system
    // user, so identity is checked the way the DB reports it: a root session
    // can read the namespace user list, brain_caller (NS EDITOR) can too, but
    // neither may be silently swapped — assert the session is the scoped one
    // by its inability to reach ROOT-only metadata.
    await sleep(PAST_EXPIRY_MS);
    await expect(
      svc.withScopedCompany(tenant, ['brain:read'], (db) => db.query('INFO FOR ROOT')),
    ).rejects.toThrow();
    // …while the root pool, which may reach it, still can.
    await expect(svc.withCompany(tenant, (db) => db.query('INFO FOR ROOT'))).resolves.toBeDefined();
  }, 60_000);
});
