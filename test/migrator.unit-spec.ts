/**
 * Unit-test for SchemaMigrator.
 *
 * We mock the Surreal connection (just `query`) and verify:
 *   - manifest loads from disk in numeric order
 *   - bootstrap DDL runs first
 *   - applied migrations are recorded in schema_migrations
 *   - already-applied migrations are skipped
 *   - duplicate migration IDs are detected as a config error
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SchemaMigrator } from '../src/db/migrator.service';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown>;
}

function makeFakeConn(initiallyApplied: string[] = []) {
  const calls: QueryCall[] = [];
  const applied: Array<{ migrationId: string; name: string }> = initiallyApplied.map((id) => ({
    migrationId: id,
    name: `${id}_seeded.surql`,
  }));
  const conn = {
    async query<T>(sql: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ sql, params });
      if (sql.includes('SELECT migrationId FROM schema_migrations')) {
        return [applied.map((a) => ({ migrationId: a.migrationId }))] as unknown as T;
      }
      if (sql.startsWith('CREATE schema_migrations')) {
        applied.push({
          migrationId: params!.id as string,
          name: params!.name as string,
        });
        return [[applied[applied.length - 1]]] as unknown as T;
      }
      // Other DDL statements just no-op
      return [[]] as unknown as T;
    },
  };
  // Strip the SELECT call from the user-visible call list once: it's an
  // implementation detail of the migrator and noisy in assertions.
  return { conn, calls, applied };
}

async function makeMigrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'migrator-test-'));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql, 'utf-8');
  }
  return dir;
}

describe('SchemaMigrator', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('loads migrations in numeric order', async () => {
    dir = await makeMigrationsDir({
      '0002_add_index.surql': 'DEFINE INDEX foo;',
      '0001_baseline.surql': 'DEFINE TABLE bar;',
      '0010_later.surql': 'DEFINE FIELD x;',
      'README.md': 'not a migration', // ignored
    });
    const migrator = new SchemaMigrator(dir);
    const manifest = await migrator.loadManifest();
    expect(manifest.map((m) => m.id)).toEqual(['0001', '0002', '0010']);
    expect(manifest[0].name).toBe('0001_baseline.surql');
    expect(manifest[0].sql).toContain('DEFINE TABLE bar');
  });

  it('applies all migrations on a fresh database', async () => {
    dir = await makeMigrationsDir({
      '0001_baseline.surql': 'DEFINE TABLE a;',
      '0002_add_b.surql': 'DEFINE TABLE b;',
    });
    const migrator = new SchemaMigrator(dir);
    const { conn, calls, applied } = makeFakeConn();
    const result = await migrator.migrate(conn as never);

    expect(result.applied).toEqual(['0001', '0002']);
    expect(result.alreadyApplied).toEqual([]);

    // First call must bootstrap the schema_migrations table
    expect(calls[0].sql).toContain('DEFINE TABLE IF NOT EXISTS schema_migrations');

    // Both migration bodies were executed
    expect(calls.some((c) => c.sql.includes('DEFINE TABLE a'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('DEFINE TABLE b'))).toBe(true);

    // And both were recorded
    expect(applied.map((a) => a.migrationId)).toEqual(['0001', '0002']);
  });

  it('skips already-applied migrations', async () => {
    dir = await makeMigrationsDir({
      '0001_baseline.surql': 'DEFINE TABLE a;',
      '0002_add_b.surql': 'DEFINE TABLE b;',
      '0003_add_c.surql': 'DEFINE TABLE c;',
    });
    const migrator = new SchemaMigrator(dir);
    const { conn, calls, applied } = makeFakeConn(['0001', '0002']);
    const result = await migrator.migrate(conn as never);

    expect(result.applied).toEqual(['0003']);
    expect(result.alreadyApplied.sort()).toEqual(['0001', '0002']);

    // 0001 + 0002 SQL bodies must NOT have been executed
    expect(calls.some((c) => c.sql.includes('DEFINE TABLE a'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('DEFINE TABLE b'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('DEFINE TABLE c'))).toBe(true);

    // 0003 is now recorded
    expect(applied.map((a) => a.migrationId).sort()).toEqual(['0001', '0002', '0003']);
  });

  it('is a no-op when all migrations are already applied', async () => {
    dir = await makeMigrationsDir({
      '0001_baseline.surql': 'DEFINE TABLE a;',
    });
    const migrator = new SchemaMigrator(dir);
    const { conn, calls } = makeFakeConn(['0001']);
    const result = await migrator.migrate(conn as never);

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(['0001']);
    expect(calls.some((c) => c.sql.includes('DEFINE TABLE a'))).toBe(false);
    expect(
      calls.some((c) => c.sql.startsWith('CREATE schema_migrations')),
    ).toBe(false);
  });

  it('tolerates a concurrent applier winning the ledger insert', async () => {
    // Two processes booting against a SHARED DB (system DB under parallel
    // e2e, multi-pod boots) both compute the same pending set; the loser's
    // ledger CREATE hits the UNIQUE index and must be treated as applied.
    dir = await makeMigrationsDir({
      '0001_baseline.surql': 'DEFINE TABLE a;',
    });
    const migrator = new SchemaMigrator(dir);
    const { conn } = makeFakeConn();
    const rawQuery = conn.query.bind(conn);
    conn.query = async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
      if (sql.startsWith('CREATE schema_migrations')) {
        throw new Error(
          "Database index `schema_migrations_id_idx` already contains '0001', with record `schema_migrations:x`",
        );
      }
      return rawQuery<T>(sql, params);
    };
    const result = await migrator.migrate(conn as never);
    expect(result.applied).toEqual(['0001']);
  });

  it('rejects duplicate migration IDs', async () => {
    dir = await makeMigrationsDir({
      '0001_baseline.surql': 'DEFINE TABLE a;',
      '0001_duplicate.surql': 'DEFINE TABLE b;',
    });
    const migrator = new SchemaMigrator(dir);
    await expect(migrator.loadManifest()).rejects.toThrow(/Duplicate migration id 0001/);
  });

  it('rejects an empty migrations directory', async () => {
    dir = await makeMigrationsDir({});
    const migrator = new SchemaMigrator(dir);
    await expect(migrator.loadManifest()).rejects.toThrow(/No migration files/);
  });

  it('caches the manifest after first load', async () => {
    dir = await makeMigrationsDir({
      '0001_baseline.surql': 'DEFINE TABLE a;',
    });
    const migrator = new SchemaMigrator(dir);
    const a = await migrator.loadManifest();
    const b = await migrator.loadManifest();
    expect(a).toBe(b); // same reference — cached
  });
});
