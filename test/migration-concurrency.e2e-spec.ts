/**
 * Two replicas booting at once against ONE empty database, on a REAL
 * SurrealDB (testcontainers, v3.2.4).
 *
 * Before the lease, both replicas computed the same pending set and
 * applied all migration files to the same database in parallel; the only
 * arbitration was five read-conflict retries inside 320ms and a
 * tolerated unique violation on the ledger insert. This suite pins the
 * properties that replaced it:
 *   - the ledger ends with exactly one row per migration, both callers
 *     return, and neither errors;
 *   - a replica that loses the race applies nothing (the holder had
 *     already finished) rather than half a manifest;
 *   - a crashed holder is taken over once its lease expires;
 *   - the whole manifest re-applies cleanly over its own output, so a
 *     retry after a failed run converges;
 *   - a file and its ledger row commit in one transaction, and an aborted
 *     one leaves neither — which is what bounds the crash window to zero,
 *     and is exactly what a plain batch would NOT give.
 */
import { Surreal } from 'surrealdb';
import { join } from 'node:path';
import { SchemaMigrator } from '../src/db/migrator.service';
import { migrationLeaseName, SurrealMigrationLock } from '../src/db/migration-lock';

const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'db', 'migrations');
/** Own namespace: the shared container also hosts every other e2e spec. */
const NS = `mig_conc_${Date.now()}`;
const TARGET_DB = 'co_two_replicas';
const LEASE_DB = 'system';

interface Replica {
  conn: Surreal;
  leaseConn: Surreal;
  migrator: SchemaMigrator;
  lock: SurrealMigrationLock;
}

async function connect(): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(process.env.SURREALDB_URL!);
  await db.signin({
    username: process.env.SURREALDB_USERNAME ?? 'root',
    password: process.env.SURREALDB_PASSWORD ?? 'root',
  });
  return db;
}

/** One replica: a migrator conn on the target DB, a lease conn on system. */
async function makeReplica(database: string): Promise<Replica> {
  const conn = await connect();
  await conn.query(`DEFINE NAMESPACE IF NOT EXISTS \`${NS}\``);
  await conn.use({ namespace: NS });
  await conn.query(`DEFINE DATABASE IF NOT EXISTS \`${database}\``);
  await conn.query(`DEFINE DATABASE IF NOT EXISTS \`${LEASE_DB}\``);
  await conn.use({ namespace: NS, database });

  const leaseConn = await connect();
  await leaseConn.use({ namespace: NS, database: LEASE_DB });

  return {
    conn,
    leaseConn,
    migrator: new SchemaMigrator(MIGRATIONS_DIR),
    lock: new SurrealMigrationLock((fn) => fn(leaseConn)),
  };
}

async function ledgerIds(conn: Surreal): Promise<string[]> {
  const [rows] = await conn.query<[Array<{ migrationId: string }>]>(
    `SELECT migrationId FROM schema_migrations`,
  );
  return (rows ?? []).map((r) => r.migrationId);
}

describe('two replicas migrating one empty database', () => {
  const replicas: Replica[] = [];

  afterAll(async () => {
    for (const r of replicas) {
      await r.conn.close().catch(() => undefined);
      await r.leaseConn.close().catch(() => undefined);
    }
  });

  it('applies the manifest exactly once and both callers return', async () => {
    const a = await makeReplica(TARGET_DB);
    const b = await makeReplica(TARGET_DB);
    replicas.push(a, b);
    const lockName = migrationLeaseName(NS, TARGET_DB);
    const manifest = await a.migrator.loadManifest();

    const started = Date.now();
    const [resA, resB] = await Promise.all([
      a.migrator.migrate(a.conn, { lock: a.lock, lockName }),
      b.migrator.migrate(b.conn, { lock: b.lock, lockName }),
    ]);
    const elapsedMs = Date.now() - started;
    // Reported so the lease TTL can be sanity-checked against reality.
    console.log(
      `[e2e] cold migration of ${manifest.length} files under contention: ${elapsedMs}ms`,
    );

    // The winner applied everything; the loser waited, re-read the ledger
    // and found nothing left to do.
    const applied = [...resA.applied, ...resB.applied];
    expect(applied.length).toBe(manifest.length);
    expect(resA.applied.length === 0 || resB.applied.length === 0).toBe(true);

    // Exactly one ledger row per migration, no duplicates, nothing missing.
    const ids = await ledgerIds(a.conn);
    expect(ids.length).toBe(manifest.length);
    expect([...ids].sort()).toEqual(manifest.map((m) => m.id));

    // The lease is handed back, not left held.
    const [leases] = await b.leaseConn.query<[Array<{ name: string }>]>(
      `SELECT name FROM leader_lease`,
    );
    expect((leases ?? []).map((l) => l.name)).not.toContain(lockName);
  }, 180_000);

  it('is a no-op on the next boot', async () => {
    const [a] = replicas;
    const lockName = migrationLeaseName(NS, TARGET_DB);
    const again = await a!.migrator.migrate(a!.conn, { lock: a!.lock, lockName });
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied.length).toBe((await a!.migrator.loadManifest()).length);
  }, 60_000);

  it('serialises the lease: the second aspirant is refused until release', async () => {
    const [a, b] = replicas;
    const name = migrationLeaseName(NS, 'lease_probe');
    expect(await a!.lock.tryAcquire(name, 30)).toBe(true);
    expect(await b!.lock.tryAcquire(name, 30)).toBe(false);
    // The holder renewing is not a second holder.
    expect(await a!.lock.tryAcquire(name, 30)).toBe(true);
    // A non-owner cannot release it.
    await b!.lock.release(name);
    expect(await b!.lock.tryAcquire(name, 30)).toBe(false);
    await a!.lock.release(name);
    expect(await b!.lock.tryAcquire(name, 30)).toBe(true);
    await b!.lock.release(name);
  }, 60_000);

  it('hands a crashed holder over once its lease expires', async () => {
    const [a, b] = replicas;
    const name = migrationLeaseName(NS, 'expiry_probe');
    // A "crash" is a holder that never releases; the TTL is the only exit.
    expect(await a!.lock.tryAcquire(name, 1)).toBe(true);
    expect(await b!.lock.tryAcquire(name, 30)).toBe(false);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await b!.lock.tryAcquire(name, 30)).toBe(true);
    await b!.lock.release(name);
  }, 60_000);

  it('re-applies the whole manifest onto its own output without error', async () => {
    // This is what bounds the crash window. A crash between a file and
    // its ledger row leaves that file applied but unrecorded, so the next
    // boot runs it again — over schema it has already created. Every file
    // must therefore survive being applied twice, which the doctrine gate
    // checks in form and this checks in fact.
    const probe = await makeReplica('replay_probe');
    replicas.push(probe);
    const lockName = migrationLeaseName(NS, 'replay_probe');
    const manifest = await probe.migrator.loadManifest();
    await probe.migrator.migrate(probe.conn, { lock: probe.lock, lockName });

    // Wipe the ledger only: the schema stays, as after a crash that lost
    // every ledger row it had not written yet.
    await probe.conn.query(`DELETE schema_migrations`);
    const replayed = await probe.migrator.migrate(probe.conn, { lock: probe.lock, lockName });
    expect(replayed.applied.length).toBe(manifest.length);
    expect((await ledgerIds(probe.conn)).length).toBe(manifest.length);
  }, 180_000);

  it('rolls DDL back with an aborted transaction, and would not without one', async () => {
    // Why `applyOne` wraps: 3.2.4 undoes DEFINE statements when the
    // transaction aborts, so a file and its ledger row commit together or
    // not at all. The unwrapped alternative — ledger row as the last
    // statement of a plain batch — is strictly worse: a plain batch keeps
    // executing after a failed statement, so the row would mark a
    // half-applied file as done.
    const wrapped = await makeReplica('crash_window_probe');
    replicas.push(wrapped);
    await wrapped.conn.query(`DEFINE TABLE IF NOT EXISTS schema_migrations SCHEMALESS`);
    await expect(
      wrapped.conn.query(
        `BEGIN TRANSACTION;
         DEFINE TABLE IF NOT EXISTS half_landed SCHEMAFULL;
         CREATE schema_migrations CONTENT { migrationId: '9999', name: 'aborted.surql' };
         THROW "killed mid-file";
         COMMIT TRANSACTION;`,
      ),
    ).rejects.toThrow();
    const [info] = await wrapped.conn.query<[{ tables?: Record<string, string> }]>(`INFO FOR DB`);
    expect(Object.keys(info?.tables ?? {})).not.toContain('half_landed');
    expect(await ledgerIds(wrapped.conn)).not.toContain('9999');

    const plain = await makeReplica('plain_batch_probe');
    replicas.push(plain);
    await plain.conn.query(`DEFINE TABLE IF NOT EXISTS schema_migrations SCHEMALESS`);
    await expect(
      plain.conn.query(
        `DEFINE TABLE IF NOT EXISTS half_landed SCHEMAFULL;
         THROW "killed mid-file";
         CREATE schema_migrations CONTENT { migrationId: '9999', name: 'aborted.surql' };`,
      ),
    ).rejects.toThrow();
    expect(await ledgerIds(plain.conn)).toEqual(['9999']);
  }, 120_000);
});
