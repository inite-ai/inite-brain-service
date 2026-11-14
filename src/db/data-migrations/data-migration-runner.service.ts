import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../../auth/api-key.service';
import { JobClaimService } from '../../jobs/job-claim.service';
import { WorkerLoopService } from '../../jobs/worker-loop.service';
import { SurrealService } from '../surreal.service';
import { DATA_MIGRATIONS, type DataMigration } from './data-migration';
import { recordDataMigrationRemaining } from './data-migration-remaining';
import { runDataMigrations, type DataMigrationRun } from './run-data-migrations';

/** Wall-clock budget of one tenant's run; what is left resumes on the next. */
export const DATA_MIGRATION_TIME_BUDGET_MS = 20_000;
/** A run cut off by its budget asks for the next one this soon. */
const RESUME_DELAY_MS = 30_000;
const HOUR_MS = 60 * 60_000;

/**
 * Runs the registered data migrations (DATA_MIGRATIONS) in every tenant of
 * the fan-out roster, as the background job `data_migrations`.
 *
 * Scheduling: an hourly cron enqueues one job per tenant (deduplicated per
 * hour, so every pod's cron lands on the same row). A tenant this process
 * has seen with every registered migration verified done is not enqueued
 * again until the next deploy brings a new migration. A run cut off by its
 * time budget enqueues its own continuation 30 s later instead of waiting
 * for the hour.
 *
 * Writes only ids, instants and flags the schema already holds, never user
 * content, and logs ids and counts only.
 */
@Injectable()
export class DataMigrationRunnerService implements OnModuleInit {
  private readonly logger = new Logger(DataMigrationRunnerService.name);
  /** Tenants whose every registered migration this process saw verified done. */
  private readonly settled = new Set<string>();

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    @Inject(DATA_MIGRATIONS) private readonly migrations: DataMigration[],
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  onModuleInit(): void {
    // The id is the ledger key: two migrations sharing one would mark each other done.
    const ids = this.migrations.map((m) => m.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new Error(`data migration id registered twice: ${dup}`);
    this.workerLoop?.register('data_migrations', (ctx) => this.runTenant(ctx.companyId), {
      ttlSeconds: 300,
      maxAttempts: 3,
    });
  }

  /** Every registered data migration: id and description, in run order. */
  registered(): Array<{ id: string; description: string }> {
    return this.migrations.map((m) => ({ id: m.id, description: m.description }));
  }

  @Cron('23 * * * *', { timeZone: 'UTC' })
  async enqueueAll(): Promise<{ enqueued: number }> {
    if (!this.claim || this.migrations.length === 0) return { enqueued: 0 };
    const hour = Math.floor(Date.now() / HOUR_MS);
    let enqueued = 0;
    for (const companyId of this.apiKeys.fanOutRoster()) {
      if (this.settled.has(companyId)) continue;
      try {
        const { created } = await this.claim.enqueue({
          jobType: 'data_migrations',
          companyId,
          triggeredBy: 'cron',
          dedupKey: `data_migrations_${hour}`,
        });
        if (created) enqueued++;
      } catch (e) {
        this.logger.warn(
          `enqueue data_migrations for ${companyId} failed: ${(e as Error).message}`,
        );
      }
    }
    return { enqueued };
  }

  async runTenant(companyId: string): Promise<Record<string, unknown>> {
    const run = await this.surreal.withCompany(companyId, (db) =>
      runDataMigrations(db, this.migrations, {
        deadline: Date.now() + DATA_MIGRATION_TIME_BUDGET_MS,
      }),
    );
    this.account(companyId, run);
    if (run.budgetExhausted) await this.resume(companyId);
    return {
      alreadyDone: run.alreadyDone.length,
      budgetExhausted: run.budgetExhausted,
      outcomes: run.outcomes,
    };
  }

  private account(companyId: string, run: DataMigrationRun): void {
    for (const id of run.alreadyDone) recordDataMigrationRemaining(id, companyId, 0);
    for (const o of run.outcomes) {
      recordDataMigrationRemaining(o.id, companyId, o.remaining);
      if (o.fixed > 0 || !o.done)
        this.logger.log(
          `data migration ${o.id} ${companyId}: fixed=${o.fixed} remaining=${o.remaining} done=${o.done}`,
        );
      if (o.stalled)
        this.logger.warn(
          `data migration ${o.id} ${companyId}: a step fixed none of ${o.remaining} pending rows`,
        );
    }
    // Not cut off and nothing left pending: every migration was reached and verified.
    if (!run.budgetExhausted && run.outcomes.every((o) => o.done)) this.settled.add(companyId);
  }

  private async resume(companyId: string): Promise<void> {
    if (!this.claim) return;
    const at = Math.ceil((Date.now() + RESUME_DELAY_MS) / RESUME_DELAY_MS) * RESUME_DELAY_MS;
    await this.claim.enqueue({
      jobType: 'data_migrations',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `data_migrations_resume_${at}`,
      visibleAfter: new Date(at),
    });
  }
}
