/**
 * Unit-test for SchemaMigrator.
 *
 * We mock the Surreal connection (just `query`) and verify:
 *   - manifest loads from disk in numeric order
 *   - bootstrap DDL runs first
 *   - each file lands together with its ledger row in one transaction
 *   - already-applied migrations are skipped
 *   - duplicate migration IDs are detected as a config error
 *   - the cross-replica lock is held for the whole run, a loser waits
 *     for the holder and then applies only what is left, and the wait
 *     has a deadline it fails on rather than serving half a schema
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SchemaMigrator } from '../src/db/migrator.service';
import { migrationLeaseName, type MigrationLock } from '../src/db/migration-lock';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown> | undefined;
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
      // One apply = one BEGIN/COMMIT batch carrying the file's DDL and
      // its ledger row, so the row appears exactly when the batch commits.
      if (sql.includes('CREATE schema_migrations CONTENT')) {
        applied.push({
          migrationId: params!.mig_id as string,
          name: params!.mig_name as string,
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

/** A lock whose holder is scripted by the test. */
function makeFakeLock(opts: { heldByOther?: number; failAcquires?: number } = {}) {
  const events: string[] = [];
  let othersTurnsLeft = opts.heldByOther ?? 0;
  let failuresLeft = opts.failAcquires ?? 0;
  let held = false;
  const lock: MigrationLock & { events: string[]; isHeld: () => boolean } = {
    events,
    isHeld: () => held,
    async tryAcquire(name: string, ttlSeconds: number): Promise<boolean> {
      if (failuresLeft > 0) {
        failuresLeft--;
        events.push(`acquire-error:${name}`);
        throw new Error('lease store unreachable');
      }
      if (othersTurnsLeft > 0) {
        othersTurnsLeft--;
        events.push(`busy:${name}`);
        return false;
      }
      events.push(`acquire:${name}:${ttlSeconds}`);
      held = true;
      return true;
    },
    async release(name: string): Promise<void> {
      held = false;
      events.push(`release:${name}`);
    },
  };
  return lock;
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
    expect(manifest[0]!.name).toBe('0001_baseline.surql');
    expect(manifest[0]!.sql).toContain('DEFINE TABLE bar');
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
    expect(calls[0]!.sql).toContain('DEFINE TABLE IF NOT EXISTS schema_migrations');

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
    expect(calls.some((c) => c.sql.includes('CREATE schema_migrations'))).toBe(false);
  });

  it('applies each file and its ledger row in one transaction', async () => {
    // The crash window this closes: DDL that survived with no ledger row,
    // so the next boot re-ran a file that had already half-landed.
    dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
    const migrator = new SchemaMigrator(dir);
    const { conn, calls } = makeFakeConn();
    await migrator.migrate(conn as never);

    const batch = calls.find((c) => c.sql.includes('DEFINE TABLE a'));
    expect(batch).toBeDefined();
    expect(batch!.sql.startsWith('BEGIN TRANSACTION;')).toBe(true);
    expect(batch!.sql).toContain('CREATE schema_migrations CONTENT');
    expect(batch!.sql.trimEnd().endsWith('COMMIT TRANSACTION;')).toBe(true);
    // Nothing writes the ledger outside that batch.
    expect(calls.filter((c) => c.sql.includes('CREATE schema_migrations CONTENT'))).toHaveLength(1);
  });

  it('records nothing when the batch fails', async () => {
    dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
    const migrator = new SchemaMigrator(dir, { sleep: async () => undefined });
    const { conn, applied } = makeFakeConn();
    const rawQuery = conn.query.bind(conn);
    conn.query = async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
      if (sql.includes('DEFINE TABLE a')) throw new Error('Parse error: nope');
      return rawQuery<T>(sql, params);
    };
    await expect(migrator.migrate(conn as never)).rejects.toThrow(/0001_baseline\.surql failed/);
    expect(applied).toEqual([]);
  });

  it('tolerates a concurrent applier winning the ledger insert', async () => {
    // A lease that expired under a live holder is the one way two
    // appliers can still overlap. The loser's batch aborts as the bare
    // "failed transaction" wrapper — indistinguishable from an OCC
    // conflict — so the migrator settles it by re-reading the ledger and
    // counts the file as applied: the DDL the racer ran was identical.
    dir = await makeMigrationsDir({
      '0001_baseline.surql': 'DEFINE TABLE a;',
    });
    const migrator = new SchemaMigrator(dir, { sleep: async () => undefined });
    const { conn, applied } = makeFakeConn();
    const rawQuery = conn.query.bind(conn);
    conn.query = async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
      if (sql.includes('CREATE schema_migrations CONTENT')) {
        applied.push({ migrationId: '0001', name: '0001_baseline.surql' });
        throw new Error('The query was not executed due to a failed transaction');
      }
      return rawQuery<T>(sql, params);
    };
    const result = await migrator.migrate(conn as never);
    expect(result.applied).toEqual(['0001']);
  });

  it('retries an OCC abort and converges', async () => {
    // NS-level DDL (0005's DEFINE USER, 0003/0006's functions) aborts
    // under concurrency; the guards make the second attempt a no-op.
    dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
    const migrator = new SchemaMigrator(dir, { sleep: async () => undefined });
    const { conn, applied } = makeFakeConn();
    const rawQuery = conn.query.bind(conn);
    let firstTry = true;
    conn.query = async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
      if (sql.includes('DEFINE TABLE a') && firstTry) {
        firstTry = false;
        throw new Error('Transaction read conflict');
      }
      return rawQuery<T>(sql, params);
    };
    const result = await migrator.migrate(conn as never);
    expect(result.applied).toEqual(['0001']);
    expect(applied.map((a) => a.migrationId)).toEqual(['0001']);
  });

  describe('cross-replica lock', () => {
    it('holds the lock for the whole run and releases it after', async () => {
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir, { lockTtlSeconds: 30 });
      const { conn } = makeFakeConn();
      const lock = makeFakeLock();
      await migrator.migrate(conn as never, { lock, lockName: 'migrate_ns_db_0f0f' });

      expect(lock.events).toEqual(['acquire:migrate_ns_db_0f0f:30', 'release:migrate_ns_db_0f0f']);
      expect(lock.isHeld()).toBe(false);
    });

    it('releases the lock when a migration fails', async () => {
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir, { sleep: async () => undefined });
      const { conn } = makeFakeConn();
      const rawQuery = conn.query.bind(conn);
      conn.query = async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
        if (sql.includes('DEFINE TABLE a')) throw new Error('Parse error: nope');
        return rawQuery<T>(sql, params);
      };
      const lock = makeFakeLock();
      await expect(migrator.migrate(conn as never, { lock, lockName: 'l' })).rejects.toThrow(
        /0001_baseline\.surql failed/,
      );
      expect(lock.events).toEqual(['acquire:l:30', 'release:l']);
    });

    it('waits for the holder, then applies only what is genuinely left', async () => {
      dir = await makeMigrationsDir({
        '0001_baseline.surql': 'DEFINE TABLE a;',
        '0002_add_b.surql': 'DEFINE TABLE b;',
      });
      const slept: number[] = [];
      const migrator = new SchemaMigrator(dir, {
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
      // The holder finished 0001 while we waited; only 0002 is left.
      const { conn, calls } = makeFakeConn(['0001']);
      const lock = makeFakeLock({ heldByOther: 3 });
      const result = await migrator.migrate(conn as never, { lock, lockName: 'l' });

      expect(lock.events).toEqual(['busy:l', 'busy:l', 'busy:l', 'acquire:l:30', 'release:l']);
      expect(slept).toEqual([50, 100, 200]); // bounded exponential backoff
      expect(result.applied).toEqual(['0002']);
      expect(calls.some((c) => c.sql.includes('DEFINE TABLE a'))).toBe(false);
      expect(calls.some((c) => c.sql.includes('DEFINE TABLE b'))).toBe(true);
    });

    it('never reads the ledger before it owns the lock', async () => {
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir, { sleep: async () => undefined });
      const { conn, calls } = makeFakeConn();
      const lock = makeFakeLock({ heldByOther: 2 });
      lock.tryAcquire = new Proxy(lock.tryAcquire, {
        apply(target, thisArg, args: [string, number]) {
          // Anything the migrator queries before it holds the lock would
          // be a decision taken on a schema another replica is changing.
          expect(calls).toEqual([]);
          return Reflect.apply(target, thisArg, args) as Promise<boolean>;
        },
      });
      await migrator.migrate(conn as never, { lock, lockName: 'l' });
      expect(calls.length).toBeGreaterThan(0);
    });

    it('fails closed when the holder never lets go', async () => {
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      let clock = 0;
      const migrator = new SchemaMigrator(dir, {
        lockWaitMs: 500,
        sleep: async (ms) => {
          clock += ms;
        },
      });
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        const { conn, calls } = makeFakeConn();
        const lock = makeFakeLock({ heldByOther: Number.MAX_SAFE_INTEGER });
        await expect(migrator.migrate(conn as never, { lock, lockName: 'l' })).rejects.toThrow(
          /Timed out after 500ms waiting for migration lock l — another replica is still applying/,
        );
        // Fail closed: nothing was applied, so the caller cannot go on to
        // serve requests against a half-migrated database.
        expect(calls).toEqual([]);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('surfaces the lease-store error when the deadline expires on failures', async () => {
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      let clock = 0;
      const migrator = new SchemaMigrator(dir, {
        lockWaitMs: 300,
        sleep: async (ms) => {
          clock += ms;
        },
      });
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        const { conn } = makeFakeConn();
        const lock = makeFakeLock({ failAcquires: Number.MAX_SAFE_INTEGER });
        await expect(migrator.migrate(conn as never, { lock, lockName: 'l' })).rejects.toThrow(
          /Timed out after 300ms waiting for migration lock l: lease store unreachable/,
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('retries a transient acquire failure inside the deadline', async () => {
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir, { sleep: async () => undefined });
      const { conn } = makeFakeConn();
      const lock = makeFakeLock({ failAcquires: 2 });
      const result = await migrator.migrate(conn as never, { lock, lockName: 'l' });
      expect(lock.events).toEqual([
        'acquire-error:l',
        'acquire-error:l',
        'acquire:l:30',
        'release:l',
      ]);
      expect(result.applied).toEqual(['0001']);
    });

    it('stops applying when the lease is lost mid-run', async () => {
      dir = await makeMigrationsDir({
        '0001_baseline.surql': 'DEFINE TABLE a;',
        '0002_add_b.surql': 'DEFINE TABLE b;',
      });
      // TTL 0 puts the lease permanently at half-life, so the migrator
      // re-checks ownership before every file; the third check loses it.
      const migrator = new SchemaMigrator(dir, { lockTtlSeconds: 0 });
      const { conn, calls } = makeFakeConn();
      const lock = makeFakeLock();
      let acquires = 0;
      const acquire = lock.tryAcquire.bind(lock);
      lock.tryAcquire = async (name, ttl) => (++acquires > 2 ? false : acquire(name, ttl));

      await expect(migrator.migrate(conn as never, { lock, lockName: 'l' })).rejects.toThrow(
        /Lost migration lock l before applying 0002_add_b\.surql/,
      );
      expect(calls.some((c) => c.sql.includes('DEFINE TABLE a'))).toBe(true);
      expect(calls.some((c) => c.sql.includes('DEFINE TABLE b'))).toBe(false);
      expect(lock.events).toContain('release:l');
    });
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

describe('migrationLeaseName', () => {
  it('stays inside the character set a record id can carry', () => {
    // The name is composed into `leader_lease:<name>`, so a ':' or '/'
    // would break id parsing and a '-' would parse as minus.
    for (const db of ['system', 'co_acme', 'co_Weird-Name_1']) {
      expect(migrationLeaseName('brain', db)).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('is per target database and stable', () => {
    expect(migrationLeaseName('brain', 'co_a')).toBe(migrationLeaseName('brain', 'co_a'));
    expect(migrationLeaseName('brain', 'co_a')).not.toBe(migrationLeaseName('brain', 'co_b'));
    expect(migrationLeaseName('brain', 'system')).not.toBe(migrationLeaseName('other', 'system'));
  });

  it('keeps targets apart that the character fold would merge', () => {
    // Folding alone maps both of these to the same slug; the appended
    // digest is what stops two tenants sharing one migration lease.
    expect(migrationLeaseName('brain', 'co_a-b')).not.toBe(migrationLeaseName('brain', 'co_a_b'));
  });
});
