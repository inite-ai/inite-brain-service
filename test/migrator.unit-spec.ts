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
import { MigrationFailedError, SchemaMigrator } from '../src/db/migrator.service';
import { migrationLeaseName, type MigrationLock } from '../src/db/migration-lock';
import { migrationChecksum, migrationDriftSnapshot } from '../src/db/migration-checksum';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

function makeFakeConn(
  initiallyApplied: string[] = [],
  checksums: Record<string, string | undefined> = {},
) {
  const calls: QueryCall[] = [];
  const applied: Array<{ id: string; migrationId: string; name: string; checksum?: string }> =
    initiallyApplied.map((id) => ({
      id: `schema_migrations:${id}`,
      migrationId: id,
      name: `${id}_seeded.surql`,
      ...(checksums[id] !== undefined ? { checksum: checksums[id] } : {}),
    }));
  const conn = {
    async query<T>(sql: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT') && sql.includes('FROM schema_migrations')) {
        return [applied.map((a) => ({ ...a }))] as unknown as T;
      }
      if (sql.startsWith('UPDATE $row SET checksum')) {
        const row = applied.find((a) => a.id === params!.row);
        if (row) row.checksum = params!.sum as string;
        return [[]] as unknown as T;
      }
      // One apply = one BEGIN/COMMIT batch carrying the file's DDL and
      // its ledger row, so the row appears exactly when the batch commits.
      if (sql.includes('CREATE schema_migrations CONTENT')) {
        applied.push({
          id: `schema_migrations:${params!.mig_id as string}`,
          migrationId: params!.mig_id as string,
          name: params!.mig_name as string,
          checksum: params!.mig_sum as string,
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
        applied.push({
          id: 'schema_migrations:0001',
          migrationId: '0001',
          name: '0001_baseline.surql',
        });
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

    it('never touches the lease when the manifest is already complete', async () => {
      // The steady state: every request after the first one for a tenant,
      // and every boot of a tenant another replica already migrated. A
      // lease round trip here would sit on the caller's request for no
      // reason, and a lease a dead holder left would block it outright.
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir);
      const { conn } = makeFakeConn(['0001']);
      const lock = makeFakeLock();
      const result = await migrator.migrate(conn as never, { lock, lockName: 'l' });

      expect(result.applied).toEqual([]);
      expect(lock.events).toEqual([]);
    });

    it('reads the ledger before it reaches for the lease', async () => {
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir);
      const { conn, calls } = makeFakeConn();
      const lock = makeFakeLock();
      lock.tryAcquire = new Proxy(lock.tryAcquire, {
        apply(target, thisArg, args: [string, number]) {
          // Read first, arbitrate second — but nothing may be APPLIED
          // before the lease is held.
          expect(calls.some((c) => c.sql.includes('FROM schema_migrations'))).toBe(true);
          expect(calls.some((c) => c.sql.includes('DEFINE TABLE a'))).toBe(false);
          return Reflect.apply(target, thisArg, args) as Promise<boolean>;
        },
      });
      const result = await migrator.migrate(conn as never, { lock, lockName: 'l' });
      expect(result.applied).toEqual(['0001']);
    });

    it('stops waiting as soon as the holder has finished the work', async () => {
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir, { sleep: async () => undefined });
      const { conn, calls, applied } = makeFakeConn();
      const lock = makeFakeLock({ heldByOther: Number.MAX_SAFE_INTEGER });
      const busy = lock.tryAcquire.bind(lock);
      lock.tryAcquire = async (name, ttl) => {
        const refused = await busy(name, ttl);
        // The holder commits the last pending file while we back off.
        applied.push({
          id: 'schema_migrations:0001',
          migrationId: '0001',
          name: '0001_baseline.surql',
        });
        return refused;
      };

      const result = await migrator.migrate(conn as never, { lock, lockName: 'l' });
      expect(result.applied).toEqual([]);
      expect(calls.some((c) => c.sql.includes('DEFINE TABLE a'))).toBe(false);
      // One refusal, then the ledger settled it — no second attempt, and
      // nothing to release because nothing was ever held.
      expect(lock.events).toEqual(['busy:l']);
    });

    it('does not fail a request when the lease store is unreachable but the schema is there', async () => {
      // A lease store we cannot reach must never turn a request against an
      // already-migrated database into a 500.
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir, { sleep: async () => undefined });
      const { conn, applied } = makeFakeConn();
      const lock = makeFakeLock({ failAcquires: Number.MAX_SAFE_INTEGER });
      const failing = lock.tryAcquire.bind(lock);
      lock.tryAcquire = async (name, ttl) => {
        applied.push({
          id: 'schema_migrations:0001',
          migrationId: '0001',
          name: '0001_baseline.surql',
        });
        return failing(name, ttl);
      };

      await expect(migrator.migrate(conn as never, { lock, lockName: 'l' })).resolves.toMatchObject(
        { applied: [] },
      );
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
        expect(calls.some((c) => c.sql.includes('DEFINE TABLE a'))).toBe(false);
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

    /**
     * A conn whose batch for `slowSql` blocks until the test opens the
     * gate, so a "long file" can be held open while real timers tick.
     */
    function withSlowFile(fake: ReturnType<typeof makeFakeConn>, slowSql: string) {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      let entered!: () => void;
      const running = new Promise<void>((r) => (entered = r));
      const rawQuery = fake.conn.query.bind(fake.conn);
      fake.conn.query = async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
        if (sql.includes(slowSql)) {
          entered();
          await gate;
        }
        return rawQuery<T>(sql, params);
      };
      return { open, running };
    }
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('renews the lease while one long file runs, and stops renewing after', async () => {
      // The defect: renewal happened only BETWEEN files, so a single file
      // longer than the TTL let the lease lapse under its own transaction.
      dir = await makeMigrationsDir({ '0001_baseline.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir, { lockTtlSeconds: 30, heartbeatMs: 5 });
      const fake = makeFakeConn();
      const slow = withSlowFile(fake, 'DEFINE TABLE a');
      const lock = makeFakeLock();
      const run = migrator.migrate(fake.conn as never, { lock, lockName: 'l' });
      await slow.running;
      await tick(40);
      const renewalsDuringFile = lock.events.filter((e) => e === 'acquire:l:30').length - 1;
      expect(renewalsDuringFile).toBeGreaterThanOrEqual(2);
      slow.open();
      await expect(run).resolves.toMatchObject({ applied: ['0001'] });
      expect(lock.events[lock.events.length - 1]).toBe('release:l');
      const settled = lock.events.length;
      await tick(30);
      expect(lock.events).toHaveLength(settled); // the timer is gone
    });

    it('stops at the next file boundary when a renewal finds the lease taken over', async () => {
      dir = await makeMigrationsDir({
        '0001_baseline.surql': 'DEFINE TABLE a;',
        '0002_add_b.surql': 'DEFINE TABLE b;',
      });
      const migrator = new SchemaMigrator(dir, { heartbeatMs: 5 });
      const fake = makeFakeConn();
      const slow = withSlowFile(fake, 'DEFINE TABLE a');
      const lock = makeFakeLock();
      let acquires = 0;
      const acquire = lock.tryAcquire.bind(lock);
      // First acquire wins; the first renewal finds another holder.
      lock.tryAcquire = async (name, ttl) => (++acquires > 1 ? false : acquire(name, ttl));
      const run = migrator.migrate(fake.conn as never, { lock, lockName: 'l' });
      await slow.running;
      await tick(30);
      slow.open();

      await expect(run).rejects.toThrow(
        /Lost migration lock l before applying 0002_add_b\.surql \(another replica took the lease over\)/,
      );
      expect(fake.calls.some((c) => c.sql.includes('DEFINE TABLE b'))).toBe(false);
      expect(lock.events).toContain('release:l');
    });

    it('rides out a transient renewal error while the lease is still valid', async () => {
      dir = await makeMigrationsDir({
        '0001_baseline.surql': 'DEFINE TABLE a;',
        '0002_add_b.surql': 'DEFINE TABLE b;',
      });
      const migrator = new SchemaMigrator(dir, { lockTtlSeconds: 30, heartbeatMs: 5 });
      const fake = makeFakeConn();
      const slow = withSlowFile(fake, 'DEFINE TABLE a');
      const lock = makeFakeLock();
      const acquire = lock.tryAcquire.bind(lock);
      let acquires = 0;
      lock.tryAcquire = async (name, ttl) => {
        if (++acquires === 2) throw new Error('lease store blip');
        return acquire(name, ttl);
      };
      const run = migrator.migrate(fake.conn as never, { lock, lockName: 'l' });
      await slow.running;
      await tick(30);
      slow.open();
      await expect(run).resolves.toMatchObject({ applied: ['0001', '0002'] });
    });

    it('gives up when renewals keep failing past the lease deadline', async () => {
      dir = await makeMigrationsDir({
        '0001_baseline.surql': 'DEFINE TABLE a;',
        '0002_add_b.surql': 'DEFINE TABLE b;',
      });
      // TTL 0: the held lease is already at its deadline, so a failed
      // renewal cannot be waited out.
      const migrator = new SchemaMigrator(dir, { lockTtlSeconds: 0, heartbeatMs: 5 });
      const fake = makeFakeConn();
      const slow = withSlowFile(fake, 'DEFINE TABLE a');
      const lock = makeFakeLock();
      const acquire = lock.tryAcquire.bind(lock);
      let acquires = 0;
      lock.tryAcquire = async (name, ttl) => {
        if (++acquires > 1) throw new Error('lease store gone');
        return acquire(name, ttl);
      };
      const run = migrator.migrate(fake.conn as never, { lock, lockName: 'l' });
      await slow.running;
      await tick(30);
      slow.open();
      await expect(run).rejects.toThrow(/Lost migration lock l before applying 0002_add_b/);
      expect(fake.calls.some((c) => c.sql.includes('DEFINE TABLE b'))).toBe(false);
    });

    it('labels a failed file with its migration id', async () => {
      dir = await makeMigrationsDir({ '0003_bad.surql': 'DEFINE TABLE a;' });
      const migrator = new SchemaMigrator(dir, { sleep: async () => undefined });
      const { conn } = makeFakeConn();
      const rawQuery = conn.query.bind(conn);
      conn.query = async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
        if (sql.includes('DEFINE TABLE a')) throw new Error('Parse error: nope');
        return rawQuery<T>(sql, params);
      };
      const err: unknown = await migrator.migrate(conn as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationFailedError);
      expect((err as MigrationFailedError).migrationId).toBe('0003');
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

describe('SchemaMigrator — checksums', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('records the checksum of every file it applies', async () => {
    dir = await makeMigrationsDir({ '0001_a.surql': 'DEFINE TABLE a;' });
    const { conn, applied } = makeFakeConn();
    await new SchemaMigrator(dir).migrate(conn as never);
    expect(applied[0]!.checksum).toBe(migrationChecksum('DEFINE TABLE a;'));
  });

  it('stamps a row applied before checksums with the current file, once', async () => {
    dir = await makeMigrationsDir({ '0001_a.surql': 'DEFINE TABLE a;' });
    const { conn, applied, calls } = makeFakeConn(['0001']);
    const migrator = new SchemaMigrator(dir);
    await migrator.migrate(conn as never);
    await migrator.migrate(conn as never);
    expect(applied[0]!.checksum).toBe(migrationChecksum('DEFINE TABLE a;'));
    expect(calls.filter((c) => c.sql.startsWith('UPDATE $row SET checksum'))).toHaveLength(1);
  });

  it('reports an edited shipped migration as drift — never re-applies it, never fails', async () => {
    dir = await makeMigrationsDir({ '0007_edited.surql': 'DEFINE TABLE b;' });
    const { conn, calls } = makeFakeConn(['0007'], {
      '0007': migrationChecksum('DEFINE TABLE a;'),
    });
    const before = migrationDriftSnapshot().get('0007') ?? 0;
    const result = await new SchemaMigrator(dir).migrate(conn as never);
    expect(result.applied).toEqual([]);
    expect(migrationDriftSnapshot().get('0007')).toBe(before + 1);
    expect(calls.some((c) => c.sql.includes('DEFINE TABLE b'))).toBe(false);
  });

  it('a matching checksum is neither drift nor rewritten', async () => {
    dir = await makeMigrationsDir({ '0009_same.surql': 'DEFINE TABLE c;' });
    const { conn, calls } = makeFakeConn(['0009'], {
      '0009': migrationChecksum('DEFINE TABLE c;'),
    });
    await new SchemaMigrator(dir).migrate(conn as never);
    expect(migrationDriftSnapshot().get('0009')).toBeUndefined();
    expect(calls.some((c) => c.sql.startsWith('UPDATE $row'))).toBe(false);
  });

  /**
   * One connection, many databases — how SurrealService really migrates:
   * every tenant goes through the single dedicated migrator connection,
   * `use()`d to each database in turn. Validation used to be marked per
   * connection, so only the first database a process touched was ever
   * checked; the drift on every later tenant went unseen.
   */
  function oneConnManyDatabases(ledgers: Record<string, ReturnType<typeof makeFakeConn>>) {
    let current = Object.keys(ledgers)[0]!;
    const conn = {
      use(db: string) {
        current = db;
      },
      async query<T>(sql: string, params?: Record<string, unknown>): Promise<T> {
        if (sql.startsWith('RETURN [session::ns(), session::db()]')) {
          return [['brain', current]] as unknown as T;
        }
        return ledgers[current]!.conn.query<T>(sql, params);
      },
    };
    return conn;
  }

  it('validates every database a shared connection migrates, not just the first', async () => {
    dir = await makeMigrationsDir({ '0011_edited.surql': 'DEFINE TABLE new;' });
    const old = migrationChecksum('DEFINE TABLE old;');
    const conn = oneConnManyDatabases({
      co_a: makeFakeConn(['0011'], { '0011': old }),
      co_b: makeFakeConn(['0011'], { '0011': old }),
    });
    const migrator = new SchemaMigrator(dir);
    const before = migrationDriftSnapshot().get('0011') ?? 0;
    conn.use('co_a');
    await migrator.migrate(conn as never, { target: 'brain/co_a' });
    conn.use('co_b');
    await migrator.migrate(conn as never, { target: 'brain/co_b' });
    // Both tenants carry the drift, so both are counted.
    expect(migrationDriftSnapshot().get('0011')).toBe(before + 2);
    // And each database is still validated only once per process.
    conn.use('co_a');
    await migrator.migrate(conn as never, { target: 'brain/co_a' });
    expect(migrationDriftSnapshot().get('0011')).toBe(before + 2);
  });

  it('asks the session which database it is on when no target is passed', async () => {
    dir = await makeMigrationsDir({ '0012_legacy.surql': 'DEFINE TABLE l;' });
    const a = makeFakeConn(['0012']);
    const b = makeFakeConn(['0012']);
    const conn = oneConnManyDatabases({ co_a: a, co_b: b });
    const migrator = new SchemaMigrator(dir);
    conn.use('co_a');
    await migrator.migrate(conn as never);
    conn.use('co_b');
    await migrator.migrate(conn as never);
    // Both pre-checksum rows were stamped: the second database was looked at.
    expect(a.applied[0]!.checksum).toBe(migrationChecksum('DEFINE TABLE l;'));
    expect(b.applied[0]!.checksum).toBe(migrationChecksum('DEFINE TABLE l;'));
  });
});
