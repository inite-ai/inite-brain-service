import type { Surreal } from 'surrealdb';
import { queryRows } from '../surreal.service';
import type { DataMigration } from './data-migration';

/** Rows one step fixes. One request each; small enough to stay a short write. */
export const DATA_MIGRATION_BATCH = 500;

export interface DataMigrationOutcome {
  id: string;
  /** Rows fixed in this run. */
  fixed: number;
  /** The re-count after this run's batches. */
  remaining: number;
  /** Verified: the re-count found nothing left. */
  done: boolean;
  /** A step fixed nothing while rows still matched: the fix does not take. */
  stalled: boolean;
}

export interface DataMigrationRun {
  outcomes: DataMigrationOutcome[];
  /** Migrations already verified done in this tenant, not touched. */
  alreadyDone: string[];
  /** Migrations not reached, or left unfinished, because the budget ran out. */
  budgetExhausted: boolean;
}

export interface DataMigrationRunOptions {
  /** Wall-clock instant (ms) after which no new step starts. */
  deadline: number;
  batchSize?: number;
  now?: () => number;
}

/**
 * One tenant's pass: every registered data migration not yet verified
 * done, in batches, until its step stops finding rows or the time budget
 * runs out; then a re-count. The ledger says `done` only when that
 * re-count is 0 — a step returning fewer rows than asked is a hint, never
 * the proof. Anything unfinished stays `pending` and the next run resumes.
 */
export async function runDataMigrations(
  db: Surreal,
  migrations: readonly DataMigration[],
  opts: DataMigrationRunOptions,
): Promise<DataMigrationRun> {
  const now = opts.now ?? Date.now;
  const run: DataMigrationRun = { outcomes: [], alreadyDone: [], budgetExhausted: false };
  for (const m of migrations) {
    if (await isDone(db, m.id)) {
      run.alreadyDone.push(m.id);
      continue;
    }
    if (now() >= opts.deadline) {
      run.budgetExhausted = true;
      continue;
    }
    const outcome = await runOne(db, m, { ...opts, now });
    await recordOutcome(db, outcome);
    run.outcomes.push(outcome);
    if (!outcome.done && !outcome.stalled) run.budgetExhausted = true;
  }
  return run;
}

async function runOne(
  db: Surreal,
  m: DataMigration,
  opts: DataMigrationRunOptions & { now: () => number },
): Promise<DataMigrationOutcome> {
  const batch = opts.batchSize ?? DATA_MIGRATION_BATCH;
  let fixed = 0;
  let lastStep = -1;
  while (opts.now() < opts.deadline) {
    lastStep = await m.step(db, batch);
    fixed += lastStep;
    if (lastStep < batch) break;
  }
  const remaining = await m.pending(db);
  // A step that came back short while rows still match was not cut off by
  // the budget: what it selects, it does not fix.
  const stalled = remaining > 0 && lastStep >= 0 && lastStep < batch;
  return { id: m.id, fixed, remaining, done: remaining === 0, stalled };
}

async function isDone(db: Surreal, id: string): Promise<boolean> {
  const rows = await queryRows<{ status?: string }>(
    db,
    `SELECT status FROM type::record('data_migration', $id)`,
    { id },
  );
  return rows[0]?.status === 'done';
}

async function recordOutcome(db: Surreal, o: DataMigrationOutcome): Promise<void> {
  await db.query(
    `UPSERT type::record('data_migration', $id) SET
       status = $status,
       fixed = (fixed ?? 0) + $fixed,
       remaining = $remaining,
       lastRunAt = time::now(),
       verifiedAt = IF $done THEN time::now() ELSE verifiedAt END`,
    {
      id: o.id,
      status: o.done ? 'done' : 'pending',
      fixed: o.fixed,
      remaining: o.remaining,
      done: o.done,
    },
  );
}
