/**
 * Migration checksums on a real SurrealDB: an applied file is recorded with
 * its checksum; the same file edited afterwards is reported as drift by the
 * next migrator and never applied again; a ledger row written before
 * checksums existed is stamped once (src/db/migration-checksum.ts).
 */
import { Surreal } from 'surrealdb';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaMigrator } from '../src/db/migrator.service';
import { migrationChecksum, migrationDriftSnapshot } from '../src/db/migration-checksum';

/** Own namespace: the shared container also hosts every other e2e spec. */
const NS = `mig_sum_${Date.now()}`;

async function connect(database: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(process.env.SURREALDB_URL!);
  await db.signin({
    username: process.env.SURREALDB_USERNAME ?? 'root',
    password: process.env.SURREALDB_PASSWORD ?? 'root',
  });
  await db.query(`DEFINE NAMESPACE IF NOT EXISTS \`${NS}\``);
  await db.use({ namespace: NS });
  await db.query(`DEFINE DATABASE IF NOT EXISTS \`${database}\``);
  await db.use({ namespace: NS, database });
  return db;
}

async function ledger(conn: Surreal) {
  const [rows] = await conn.query<[Array<{ migrationId: string; checksum?: string }>]>(
    `SELECT migrationId, checksum FROM schema_migrations`,
  );
  return rows ?? [];
}

describe('migration checksums (real SurrealDB)', () => {
  let dir: string;
  const conns: Surreal[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mig-sum-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterAll(async () => {
    for (const c of conns) await c.close().catch(() => undefined);
    const root = await connect('cleanup');
    await root.query(`REMOVE NAMESPACE IF EXISTS \`${NS}\``).catch(() => undefined);
    await root.close();
  });

  it('records, then reports an edited file as drift without applying it', async () => {
    const conn = await connect('co_drift');
    conns.push(conn);
    const original = 'DEFINE TABLE IF NOT EXISTS drift_a SCHEMALESS;';
    await writeFile(join(dir, '0001_a.surql'), original);
    await new SchemaMigrator(dir).migrate(conn);
    expect(await ledger(conn)).toEqual([
      { migrationId: '0001', checksum: migrationChecksum(original) },
    ]);

    // The shipped file is edited: a new table the database never gets.
    await writeFile(join(dir, '0001_a.surql'), `${original}\nDEFINE TABLE drift_b SCHEMALESS;`);
    const before = migrationDriftSnapshot().get('0001') ?? 0;
    const result = await new SchemaMigrator(dir).migrate(conn);
    expect(result.applied).toEqual([]);
    expect(migrationDriftSnapshot().get('0001')).toBe(before + 1);
    const [info] = await conn.query<[{ tables: Record<string, unknown> }]>('INFO FOR DB');
    expect(Object.keys(info.tables)).not.toContain('drift_b');
  });

  it('stamps a ledger row written before checksums existed, once', async () => {
    const conn = await connect('co_legacy');
    conns.push(conn);
    const sql = 'DEFINE TABLE IF NOT EXISTS legacy_a SCHEMALESS;';
    await writeFile(join(dir, '0001_a.surql'), sql);
    await new SchemaMigrator(dir).migrate(conn);
    await conn.query(`UPDATE schema_migrations SET checksum = NONE`);
    expect((await ledger(conn))[0]!.checksum).toBeUndefined();

    await new SchemaMigrator(dir).migrate(conn);
    expect((await ledger(conn))[0]!.checksum).toBe(migrationChecksum(sql));
  });
});
