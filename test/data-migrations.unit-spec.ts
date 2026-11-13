/**
 * Data migrations (src/db/data-migrations/): row fixes that left the schema
 * migrations after 0182 and 0164's backfills silently did nothing on
 * production (3.2.4: `UPDATE t … WHERE` planned through an index on the
 * filtered field is a no-op). Pinned here:
 *   - the fix updates explicit record ids, never `UPDATE <table> WHERE`;
 *   - the ledger says `done` only after a re-count of 0, and a run cut off
 *     by its budget stays pending and resumes;
 *   - the remaining rows are exported per migration id, without a tenant;
 *   - the migrations reach the runner through DI.
 */
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Registry } from 'prom-client';
import type { Surreal } from 'surrealdb';
import { ApiKeyService } from '../src/auth/api-key.service';
import { DATA_MIGRATIONS, type DataMigration } from '../src/db/data-migrations/data-migration';
import {
  dataMigrationRemainingSnapshot,
  resetDataMigrationRemaining,
} from '../src/db/data-migrations/data-migration-remaining';
import { DataMigrationRunnerService } from '../src/db/data-migrations/data-migration-runner.service';
import { DataMigrationsModule } from '../src/db/data-migrations/data-migrations.module';
import { EdgeResolutionCheckedMigration } from '../src/db/data-migrations/edge-resolution-checked.migration';
import { EdgeValidFromCreatedMigration } from '../src/db/data-migrations/edge-valid-from-created.migration';
import { EdgeValidUntilFromInvalidatedMigration } from '../src/db/data-migrations/edge-valid-until-from-invalidated.migration';
import { runDataMigrations } from '../src/db/data-migrations/run-data-migrations';
import { SurrealService } from '../src/db/surreal.service';
import { JobClaimService } from '../src/jobs/job-claim.service';
import { processGauges } from '../src/metrics/process-gauges';

type Query = (sql: string, vars?: Record<string, unknown>) => Promise<unknown[]>;

/** A db whose `query` answers the ledger statements from a map and records the rest. */
function ledgerDb(ledger = new Map<string, Record<string, unknown>>()) {
  const calls: Array<{ sql: string; vars: Record<string, unknown> | undefined }> = [];
  const query: Query = async (sql, vars) => {
    calls.push({ sql, vars });
    const id = vars?.id as string;
    if (sql.includes(`SELECT status FROM type::record('data_migration'`)) {
      const row = ledger.get(id);
      return [row ? [{ status: row.status }] : []];
    }
    if (sql.includes(`UPSERT type::record('data_migration'`)) {
      const prev = ledger.get(id);
      ledger.set(id, {
        status: vars!.status,
        fixed: Number(prev?.fixed ?? 0) + Number(vars!.fixed),
        remaining: vars!.remaining,
        verifiedAt: vars!.done ? 'now' : prev?.verifiedAt,
      });
      return [[]];
    }
    return [[]];
  };
  return { db: { query } as unknown as Surreal, ledger, calls };
}

/** A migration over `rows` broken rows; `fixes` = whether step actually fixes them. */
function fakeMigration(id: string, rows: number, fixes = true) {
  const state = { rows, steps: 0 };
  const m: DataMigration = {
    id,
    description: `fake ${id}`,
    pending: async () => state.rows,
    step: async (_db, limit) => {
      state.steps++;
      const n = Math.min(limit, state.rows);
      if (fixes) state.rows -= n;
      return fixes ? n : 0;
    },
  };
  return { m, state };
}

describe('IdBatchMigration: ids first, then UPDATE of exactly those ids', () => {
  const cases = [
    new EdgeResolutionCheckedMigration(),
    new EdgeValidUntilFromInvalidatedMigration(),
    new EdgeValidFromCreatedMigration(),
  ];

  it.each(cases.map((m) => [m.id, m] as const))(
    '%s never updates the table by WHERE',
    async (_id, m) => {
      const sqls: string[] = [];
      const db = {
        query: async (sql: string) => {
          sqls.push(sql);
          return [null, ['knowledge_edge:a', 'knowledge_edge:b']];
        },
      } as unknown as Surreal;
      await expect(m.step(db, 500)).resolves.toBe(2);
      const sql = sqls[0]!;
      expect(sql).toMatch(
        /LET \$ids = \(SELECT VALUE id FROM knowledge_edge WHERE .+ LIMIT \$n\);/,
      );
      expect(sql).toMatch(/UPDATE \$ids SET /);
      expect(sql).not.toMatch(/UPDATE knowledge_edge\b/);
    },
  );

  it('counts pending with one aggregate', async () => {
    const sqls: string[] = [];
    const db = {
      query: async (sql: string) => {
        sqls.push(sql);
        return [[{ c: 7 }]];
      },
    } as unknown as Surreal;
    await expect(new EdgeResolutionCheckedMigration().pending(db)).resolves.toBe(7);
    expect(sqls[0]).toContain('SELECT count() AS c FROM knowledge_edge WHERE');
    expect(sqls[0]).toContain('GROUP ALL');
  });

  it('an empty table counts 0, not NaN', async () => {
    const db = { query: async () => [[]] } as unknown as Surreal;
    await expect(new EdgeValidFromCreatedMigration().pending(db)).resolves.toBe(0);
  });

  it('the correctives keep their intent', () => {
    const [checked, until, from] = cases as unknown as Array<{ where: string; set: string }>;
    // 0182: closed on either axis → checked.
    expect(checked!.where).toContain('resolutionCheckedAt IS NONE');
    expect(checked!.where).toContain('validUntil IS NOT NONE OR invalidatedAt IS NOT NONE');
    // 0164 second UPDATE.
    expect(until!.where).toBe('validUntil IS NONE AND invalidatedAt IS NOT NONE');
    expect(until!.set).toContain('validUntil = invalidatedAt');
    // Only open edges get a start.
    expect(from!.where).toBe('validFrom IS NONE AND validUntil IS NONE AND invalidatedAt IS NONE');
    expect(from!.set).toBe('validFrom = createdAt');
  });
});

describe('runDataMigrations: done only when verified', () => {
  it('fixes in batches until nothing is left, then records done with the re-count', async () => {
    const { db, ledger } = ledgerDb();
    const { m, state } = fakeMigration('a', 1234);
    const run = await runDataMigrations(db, [m], { deadline: Date.now() + 60_000, batchSize: 500 });
    expect(state.steps).toBe(3);
    expect(run.outcomes).toEqual([
      { id: 'a', fixed: 1234, remaining: 0, done: true, stalled: false },
    ]);
    expect(run.budgetExhausted).toBe(false);
    expect(ledger.get('a')).toMatchObject({
      status: 'done',
      fixed: 1234,
      remaining: 0,
      verifiedAt: 'now',
    });
  });

  it('a migration already verified done is not run again', async () => {
    const { db } = ledgerDb(new Map([['a', { status: 'done' }]]));
    const { m, state } = fakeMigration('a', 10);
    const run = await runDataMigrations(db, [m], { deadline: Date.now() + 60_000 });
    expect(state.steps).toBe(0);
    expect(run.alreadyDone).toEqual(['a']);
    expect(run.outcomes).toEqual([]);
  });

  it('a run out of budget stays pending, and the next run resumes from the ledger', async () => {
    const { db, ledger } = ledgerDb();
    const { m, state } = fakeMigration('a', 1500);
    let t = 0;
    // Each step costs one tick; the budget allows one step.
    const now = () => t++;
    const first = await runDataMigrations(db, [m], { deadline: 2, batchSize: 500, now });
    expect(first.budgetExhausted).toBe(true);
    expect(ledger.get('a')).toMatchObject({ status: 'pending', fixed: 500, remaining: 1000 });
    expect(ledger.get('a')!.verifiedAt).toBeUndefined();

    const second = await runDataMigrations(db, [m], {
      deadline: Date.now() + 60_000,
      batchSize: 500,
    });
    expect(second.budgetExhausted).toBe(false);
    expect(state.rows).toBe(0);
    expect(ledger.get('a')).toMatchObject({ status: 'done', fixed: 1500, remaining: 0 });
  });

  it('a step that fixes nothing while rows remain is stalled, never done', async () => {
    const { db, ledger } = ledgerDb();
    const { m } = fakeMigration('a', 20, false);
    const run = await runDataMigrations(db, [m], { deadline: Date.now() + 60_000 });
    expect(run.outcomes[0]).toMatchObject({ done: false, stalled: true, remaining: 20 });
    expect(ledger.get('a')!.status).toBe('pending');
    // Stalled is not a budget problem: no hurried retry.
    expect(run.budgetExhausted).toBe(false);
  });

  it('a step that came back short but left rows (written meanwhile) is not trusted as done', async () => {
    const { db, ledger } = ledgerDb();
    const state = { rows: 3 };
    const m: DataMigration = {
      id: 'racy',
      description: 'rows keep arriving',
      pending: async () => state.rows,
      step: async () => {
        state.rows = 1; // fixed 3, one more arrived after the select
        return 3;
      },
    };
    await runDataMigrations(db, [m], { deadline: Date.now() + 60_000 });
    expect(ledger.get('racy')).toMatchObject({ status: 'pending', remaining: 1 });
  });

  it('runs migrations in the order given', async () => {
    const { db } = ledgerDb();
    const order: string[] = [];
    const mk = (id: string): DataMigration => ({
      id,
      description: id,
      pending: async () => 0,
      step: async () => {
        order.push(id);
        return 0;
      },
    });
    await runDataMigrations(db, [mk('x'), mk('y'), mk('z')], { deadline: Date.now() + 60_000 });
    expect(order).toEqual(['x', 'y', 'z']);
  });
});

describe('brain_data_migration_remaining', () => {
  afterEach(() => resetDataMigrationRemaining());

  it('sums remaining rows per migration id, with no tenant label', async () => {
    const registry = new Registry();
    processGauges(registry);
    const { recordDataMigrationRemaining } =
      await import('../src/db/data-migrations/data-migration-remaining');
    recordDataMigrationRemaining('edge_resolution_checked', 'co_a', 12);
    recordDataMigrationRemaining('edge_resolution_checked', 'co_b', 8);
    recordDataMigrationRemaining('edge_resolution_checked', 'co_a', 2);
    recordDataMigrationRemaining('edge_valid_from_created', 'co_a', 0);
    const text = await registry.metrics();
    expect(text).toContain(
      'brain_data_migration_remaining{migration="edge_resolution_checked"} 10',
    );
    expect(text).toContain('brain_data_migration_remaining{migration="edge_valid_from_created"} 0');
    expect(text).not.toMatch(/brain_data_migration_remaining\{[^}]*(tenant|company)/);
  });
});

describe('DataMigrationRunnerService', () => {
  afterEach(() => resetDataMigrationRemaining());

  function runner(migrations: DataMigration[], roster = ['co_a', 'co_b']) {
    const { db, ledger } = ledgerDb();
    const surreal = {
      withCompany: async (_c: string, fn: (d: Surreal) => Promise<unknown>) => fn(db),
    } as unknown as SurrealService;
    const apiKeys = { fanOutRoster: () => roster } as unknown as ApiKeyService;
    const enqueue = jest.fn(async () => ({ runId: 'r', created: true }));
    const claim = { enqueue } as unknown as JobClaimService;
    const register = jest.fn();
    const svc = new DataMigrationRunnerService(
      surreal,
      migrations,
      apiKeys,
      { register } as never,
      claim,
    );
    return { svc, ledger, enqueue, register };
  }

  it('registers the data_migrations job', () => {
    const { svc, register } = runner([fakeMigration('a', 0).m]);
    svc.onModuleInit();
    expect(register).toHaveBeenCalledWith(
      'data_migrations',
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('refuses two migrations with one id (the ledger key)', () => {
    const { svc } = runner([fakeMigration('a', 0).m, fakeMigration('a', 0).m]);
    expect(() => svc.onModuleInit()).toThrow(/registered twice: a/);
  });

  it('enqueues every roster tenant once per hour, then skips tenants verified done', async () => {
    const { svc, enqueue } = runner([fakeMigration('a', 3).m]);
    await expect(svc.enqueueAll()).resolves.toEqual({ enqueued: 2 });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: 'data_migrations', triggeredBy: 'cron' }),
    );
    await svc.runTenant('co_a');
    enqueue.mockClear();
    await svc.enqueueAll();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'co_b' }));
  });

  it('a tenant run records remaining rows and the result carries counts only', async () => {
    const { svc } = runner([fakeMigration('a', 42).m, fakeMigration('b', 0).m]);
    const result = await svc.runTenant('co_a');
    expect(Object.fromEntries(dataMigrationRemainingSnapshot())).toEqual({ a: 0, b: 0 });
    expect(result).toMatchObject({ budgetExhausted: false });
  });

  it('a stalled tenant stays enqueued for the next hour', async () => {
    const { svc, enqueue } = runner([fakeMigration('a', 5, false).m], ['co_a']);
    await svc.runTenant('co_a');
    expect(Object.fromEntries(dataMigrationRemainingSnapshot())).toEqual({ a: 5 });
    await svc.enqueueAll();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'co_a' }));
  });
});

describe('DataMigrationsModule: the migrations arrive through DI', () => {
  it('provides the three correctives, closing pre-0164 edges first', async () => {
    @Global()
    @Module({
      providers: [
        { provide: SurrealService, useValue: {} },
        { provide: ApiKeyService, useValue: { fanOutRoster: () => [] } },
      ],
      exports: [SurrealService, ApiKeyService],
    })
    class Stubs {}
    const ref = await Test.createTestingModule({
      imports: [Stubs, DataMigrationsModule],
    }).compile();
    const migrations = ref.get<DataMigration[]>(DATA_MIGRATIONS);
    expect(migrations.map((m) => m.id)).toEqual([
      'edge_valid_until_from_invalidated',
      'edge_resolution_checked',
      'edge_valid_from_created',
    ]);
    expect(ref.get(DataMigrationRunnerService).registered()).toHaveLength(3);
  });
});
