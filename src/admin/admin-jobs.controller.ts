import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import {
  JobRunService,
  JobStatus,
  JobType,
} from '../jobs/job-run.service';
import { JobClaimService } from '../jobs/job-claim.service';
import { LeaderLeaseService } from '../jobs/leader-lease.service';
import { WorkerLoopService } from '../jobs/worker-loop.service';
import { JobWorkerPool } from '../jobs/job-worker-pool.service';
import { DreamsService } from '../dreams/dreams.service';
import { CalibrationRefitService } from '../ai/calibration/calibration-refit.service';
import { CompactionService } from '../compaction/compaction.service';
import { ChangefeedConsumerService } from '../audit/changefeed-consumer.service';
// eslint-disable-next-line import/no-restricted-paths -- TODO: layer migration. Move the inline withCompany() / withAdminDb() queries below into a dedicated admin service, then drop this import. New controllers MUST NOT import db/* directly.
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import { ConfigService } from '@nestjs/config';
import { HttpCode } from '@nestjs/common';
import { ReindexEmbeddingsService } from '../ai/embedder/reindex-embeddings.service';
import {
  ScenarioRunnerService,
  ScenarioRunOutcome,
} from './scenario-runner.service';
import type { LeasesResponse } from '../contracts/admin/leases.schema';

/**
 * Scheduler / jobs / maintenance surface.
 *
 *   /v1/admin/jobs              — list/get + SSE stream of long-running jobs
 *   /v1/admin/scheduler         — registered cron entries with last/next fire
 *   /v1/admin/changefeed/state  — consumer lag + cursor table
 *   /v1/admin/maintenance/...   — manual triggers
 *
 * Kept in its own controller (rather than bolted onto AdminController)
 * because the operator workflow is genuinely distinct: this is the
 * "what's running right now / what will run next / when did X last
 * complete" cockpit.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminJobsController {
  // TODO: bundle Phase J/K deps (claim, leaderLease, workerLoop,
  // workerPool, config) into an injectable JobsAdminDeps so this
  // constructor drops back under the max-params gate. Tracked with
  // the dreams.service.ts companion TODO.
  // eslint-disable-next-line max-params
  constructor(
    private readonly jobs: JobRunService,
    private readonly dreams: DreamsService,
    private readonly calibrationRefit: CalibrationRefitService,
    private readonly changefeed: ChangefeedConsumerService,
    private readonly scheduler: SchedulerRegistry,
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    private readonly reindex: ReindexEmbeddingsService,
    private readonly scenarios: ScenarioRunnerService,
    private readonly claim: JobClaimService,
    private readonly leaderLease: LeaderLeaseService,
    private readonly workerLoop: WorkerLoopService,
    private readonly workerPool: JobWorkerPool,
    private readonly compaction: CompactionService,
    private readonly config: ConfigService,
  ) {}

  @Get('jobs')
  @RequireScopes('brain:admin')
  async listJobs(
    @Query('jobType') jobType?: string,
    @Query('status') status?: string,
    @Query('since') since?: string,
    @Query('companyId') companyId?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const rows = await this.jobs.list({
      jobType: (jobType?.trim() as JobType) || undefined,
      status: (status?.trim() as JobStatus) || undefined,
      since: since?.trim() || undefined,
      companyId: companyId?.trim() || undefined,
      limit:
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined,
    });
    return { jobs: rows };
  }

  @Get('jobs/:runId')
  @RequireScopes('brain:admin')
  async getJob(
    @Req() req: AuthenticatedRequest,
    @Param('runId') runId: string,
  ) {
    // Try caller's company first; admins may also query across tenants
    // via the explicit companyId query string on /jobs list endpoint.
    const row = await this.jobs.get(runId, req.brainAuth.companyId);
    if (!row) throw new NotFoundException(`Job ${runId} not found`);
    return row;
  }

  @Post('jobs/:runId/cancel')
  @RequireScopes('brain:admin')
  async cancelJob(
    @Req() req: AuthenticatedRequest,
    @Param('runId') runId: string,
  ) {
    const ok = await this.jobs.requestCancel(runId, req.brainAuth.companyId);
    return { cancelRequested: ok };
  }

  /**
   * SSE stream of job_run transitions (start, progress update, finish).
   * Scoped to caller's tenant. Useful for live progress bars on the
   * /admin/jobs page without polling.
   */
  @Sse('jobs/stream')
  @RequireScopes('brain:admin')
  streamJobs(@Req() req: AuthenticatedRequest): Observable<{ data: unknown }> {
    const tenant = req.brainAuth.companyId;
    return this.jobs.observe().pipe(
      filter((j) => !tenant || j.companyId === tenant),
      map((j) => ({ data: j })),
    );
  }

  /**
   * List @Cron / @Interval / @Timeout entries registered on the Nest
   * scheduler at boot. last-run / next-run come from CronJob.lastDate /
   * nextDate so we don't need a separate persistence layer.
   */
  @Get('scheduler')
  @RequireScopes('brain:admin')
  scheduler_(): {
    cron: Array<{
      name: string;
      cronTime: string;
      lastFireAt: string | null;
      nextFireAt: string | null;
      running: boolean;
    }>;
    intervals: string[];
    timeouts: string[];
  } {
    const cronEntries: Array<{
      name: string;
      cronTime: string;
      lastFireAt: string | null;
      nextFireAt: string | null;
      running: boolean;
    }> = [];
    try {
      const all = this.scheduler.getCronJobs();
      for (const [name, job] of all.entries()) {
        // CronJob from `cron` package — runtime shape; loosely typed.
        const j = job as unknown as {
          cronTime?: { source?: string };
          lastDate?: () => Date | null;
          nextDate?: () => unknown;
          running?: boolean;
        };
        const lastDate = (() => {
          try {
            const d = j.lastDate?.();
            return d ? new Date(d).toISOString() : null;
          } catch {
            return null;
          }
        })();
        const nextDate = (() => {
          try {
            const n = j.nextDate?.() as { toJSDate?: () => Date } | Date | null;
            if (!n) return null;
            const d =
              n instanceof Date
                ? n
                : typeof (n as { toJSDate?: () => Date }).toJSDate ===
                    'function'
                  ? (n as { toJSDate: () => Date }).toJSDate()
                  : null;
            return d ? d.toISOString() : null;
          } catch {
            return null;
          }
        })();
        cronEntries.push({
          name,
          cronTime: j.cronTime?.source ?? '',
          lastFireAt: lastDate,
          nextFireAt: nextDate,
          running: j.running === true,
        });
      }
    } catch {
      // SchedulerRegistry is best-effort; empty list on failure.
    }
    return {
      cron: cronEntries,
      intervals: [...this.scheduler.getIntervals()],
      timeouts: [...this.scheduler.getTimeouts()],
    };
  }

  // ── Manual triggers ──────────────────────────────────────────────
  //
  // All maintenance endpoints follow the 202 + runId pattern: kick the
  // work into the JobRunService loop, drop the await, return the runId
  // so the UI can subscribe to /jobs/stream + open /jobs?runId=… for
  // drill. Returning sync would hold a Surreal pool connection for
  // minutes and block the browser tab.

  @Post('maintenance/dreams/run')
  @HttpCode(202)
  @RequireScopes('brain:admin')
  triggerDreams(
    @Req() req: AuthenticatedRequest,
    @Body() body: { operations?: ('dedup' | 'resolve' | 'summarize')[] } = {},
  ): { accepted: true; jobType: 'dreams'; companyId: string } {
    void this.dreams
      .runForTenant(
        req.brainAuth.companyId,
        body.operations ?? ['dedup', 'resolve'],
        {
          triggeredBy: 'manual',
          triggeredByActor: req.brainAuth.companyId,
        },
      )
      .catch(() => {
        /* DreamsService writes its own job_run row + logs */
      });
    return {
      accepted: true,
      jobType: 'dreams',
      companyId: req.brainAuth.companyId,
    };
  }

  /**
   * Manual compaction trigger. Under queue mode this still goes through
   * the normal cron path (each tenant's compactCompany runs inline here
   * — same code path the cron uses). For a queue-routed run, drop a
   * `compaction` row into job_run via `claim.enqueue` directly — but
   * that's a power-user move; the normal operator workflow is "trigger
   * → see it in /admin/jobs → done".
   */
  @Post('maintenance/compaction')
  @HttpCode(202)
  @RequireScopes('brain:admin')
  triggerCompaction(
    @Req() req: AuthenticatedRequest,
    @Body() body: { companyId?: string } = {},
  ): { accepted: true; jobType: 'compaction'; tenants: string[] } {
    const target = body.companyId
      ? [body.companyId]
      : this.apiKeys.knownCompanyIds();
    void (async () => {
      for (const companyId of target) {
        try {
          await this.compaction.compactCompany(companyId);
        } catch (e) {
          // compactCompany logs internally; swallow so one bad tenant
          // doesn't stop the rest of the fan-out.
          void e;
        }
      }
    })();
    void req;
    return { accepted: true, jobType: 'compaction', tenants: target };
  }

  @Post('maintenance/calibration-refit')
  @HttpCode(202)
  @RequireScopes('brain:admin')
  triggerCalibrationRefit(
    @Req() req: AuthenticatedRequest,
  ): { accepted: true; jobs: string[] } {
    const trigger = {
      triggeredBy: 'manual' as const,
      triggeredByActor: req.brainAuth.companyId,
    };
    void this.calibrationRefit.refitCalibration(trigger).catch(() => {});
    void this.calibrationRefit.refitSourceTrust(trigger).catch(() => {});
    return {
      accepted: true,
      jobs: ['calibration_refit', 'source_trust_refit'],
    };
  }

  /**
   * Re-embed knowledge_fact across one or all tenants. Lifted from the
   * synchronous /v1/admin/reindex/embeddings handler so an operator
   * triggering a full re-embed doesn't have to keep their browser tab
   * open for the duration. Result lands in job_run with the same shape
   * the sync endpoint returned (tenantsScanned, factsScanned, factsUpdated).
   */
  @Post('maintenance/reindex')
  @HttpCode(202)
  @RequireScopes('brain:admin')
  async triggerReindex(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: { tenant?: string; dryRun?: boolean; maxFacts?: number } = {},
  ): Promise<{ accepted: true; runId: string }> {
    const tenants = this.apiKeys.knownCompanyIds();
    const hostTenant = body.tenant?.trim() || tenants[0];
    const row = await this.jobs.start({
      jobType: 'reindex_embeddings',
      companyId: hostTenant,
      triggeredBy: 'manual',
      triggeredByActor: req.brainAuth.companyId,
      initialProgress: {
        tenantFilter: body.tenant?.trim() ?? null,
        dryRun: body.dryRun === true,
        maxFacts: body.maxFacts ?? null,
      },
    });
    void (async () => {
      try {
        const result = await this.reindex.run({
          tenant: body.tenant?.trim() || undefined,
          dryRun: body.dryRun === true,
          maxFacts: body.maxFacts ?? undefined,
        });
        await this.jobs.finish(row, {
          status: 'succeeded',
          result: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
        });
      } catch (e) {
        await this.jobs.finish(row, {
          status: 'failed',
          error: { message: (e as Error).message, name: (e as Error).name },
        });
      }
    })();
    return { accepted: true, runId: row.runId };
  }

  /**
   * Async batch scenarios. The synchronous /scenarios/run-batch
   * endpoint stays for back-compat (it caps at 10 and is used by the
   * eval UI); this version is for "run my entire 50-scenario regression
   * suite in the background" workflows.
   */
  @Post('maintenance/scenarios/batch')
  @HttpCode(202)
  @RequireScopes('brain:admin')
  async triggerScenariosBatch(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      ids?: string[];
      vertical?: string;
      keepTenant?: boolean;
    } = {},
  ): Promise<{ accepted: true; runId: string; scenarioCount: number }> {
    const all = this.scenarios.list();
    const candidates = body.ids?.length
      ? body.ids
      : body.vertical
        ? all.filter((s) => s.vertical === body.vertical).map((s) => s.id)
        : all.map((s) => s.id);
    const tenants = this.apiKeys.knownCompanyIds();
    const hostTenant = tenants[0];
    const row = await this.jobs.start({
      jobType: 'reindex_embeddings', // reuses generic generic-job storage; future: 'scenarios_batch'
      companyId: hostTenant,
      triggeredBy: 'manual',
      triggeredByActor: req.brainAuth.companyId,
      initialProgress: { scenarioCount: candidates.length, processed: 0 },
    });
    void (async () => {
      const outcomes: ScenarioRunOutcome[] = [];
      try {
        for (const id of candidates) {
          if (await this.jobs.isCancelRequested(row.runId, hostTenant)) {
            await this.jobs.finish(row, {
              status: 'cancelled',
              result: { processed: outcomes.length, outcomes },
            });
            return;
          }
          try {
            outcomes.push(
              await this.scenarios.runOne(id, {
                keepTenant: body.keepTenant === true,
              }),
            );
          } catch (e) {
            await this.jobs.updateProgress(row, {
              processed: outcomes.length + 1,
              lastError: (e as Error).message,
            });
          }
          await this.jobs.updateProgress(row, {
            processed: outcomes.length,
            total: candidates.length,
          });
        }
        await this.jobs.finish(row, {
          status: 'succeeded',
          result: {
            processed: outcomes.length,
            outcomes: outcomes.map((o) => ({
              scenarioId: o.scenarioId,
              passed: o.passed,
              recallAt1: o.metrics?.recallAt1,
              recallAt5: o.metrics?.recallAt5,
            })),
          },
        });
      } catch (e) {
        await this.jobs.finish(row, {
          status: 'failed',
          error: { message: (e as Error).message },
        });
      }
    })();
    return {
      accepted: true,
      runId: row.runId,
      scenarioCount: candidates.length,
    };
  }

  /**
   * Per-run emit drill for Dreams. Returns the emit rows the
   * specified run produced (identity_link / resolution / summary).
   * If no runId is given, returns the most recent successful run's
   * emits across known tenants.
   */
  @Get('dreams/runs/:runId/emits')
  @RequireScopes('brain:admin')
  async dreamEmits(
    @Param('runId') runId: string,
    @Query('companyId') companyIdQ?: string,
  ): Promise<{ runId: string; emits: Array<Record<string, unknown>> }> {
    const tenants = companyIdQ
      ? [companyIdQ]
      : this.apiKeys.knownCompanyIds();
    const emits: Array<Record<string, unknown>> = [];
    for (const companyId of tenants) {
      try {
        const rows = await this.surreal.withCompany(companyId, async (db) => {
          const res = (await db.query<any[]>(
            `SELECT runId, kind, ts, subject, object, detail
               FROM dream_emit WHERE runId = $runId ORDER BY ts ASC`,
            { runId },
          )) as any[];
          return (res[0] ?? []) as any[];
        });
        for (const r of rows) {
          emits.push({
            runId: r.runId,
            kind: r.kind,
            ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString(),
            subject: r.subject ?? null,
            object: r.object ?? null,
            detail: r.detail ?? null,
            companyId,
          });
        }
      } catch {
        // tenant without the emit table or no match — skip silently
      }
    }
    return { runId, emits };
  }

  /**
   * Top-level Dreams summary: recent run list (filtered to jobType
   * 'dreams') + aggregate counters across the last 30 days. Cheap;
   * meant for the dedicated /admin/dreams page.
   */
  @Get('dreams/summary')
  @RequireScopes('brain:admin')
  async dreamsSummary() {
    const runs = await this.jobs.list({
      jobType: 'dreams',
      limit: 100,
    });
    let identityLinks = 0;
    let resolutions = 0;
    let totalRuns = 0;
    let failed = 0;
    const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    for (const r of runs) {
      if (r.startedAt < since) continue;
      totalRuns += 1;
      if (r.status === 'failed') failed += 1;
      const res = r.result as Record<string, number> | null;
      identityLinks += Number(res?.identityLinksCreated ?? 0);
      resolutions += Number(res?.resolutionsApplied ?? 0);
    }
    return {
      runs,
      aggregates30d: {
        totalRuns,
        failed,
        identityLinksCreated: identityLinks,
        resolutionsApplied: resolutions,
      },
    };
  }

  /**
   * Leader-election + active-claim cockpit. One screen that answers:
   *
   *   - which pod holds each named lease (dreams_all, compaction_*,
   *     worker_loop, lease_manager_cron, changefeed_consumer …)
   *   - how long is each lease good for, when was it last heartbeated
   *   - which job_run rows are CURRENTLY claimed: which pod, attempt,
   *     leaseUntil, heartbeatAt — surfacing stuck workers before the
   *     reaper kicks in
   *   - this pod's role: leader / follower, registered handler types
   *
   * Read-only. Cross-tenant scan of running rows is capped at 50 per
   * tenant inside JobClaimService.listActiveClaims so a noisy tenant
   * can't crowd the screen.
   */
  @Get('leases')
  @RequireScopes('brain:admin')
  async leases(): Promise<LeasesResponse> {
    const [leaderLeases, activeClaims] = await Promise.all([
      this.leaderLease.list(),
      this.claim.listActiveClaims(this.apiKeys.knownCompanyIds()),
    ]);
    const now = Date.now();
    const queueMode =
      (this.config.get<string>('JOBS_QUEUE_MODE', 'enqueue') ?? 'enqueue') as
        | 'enqueue'
        | 'inline';
    return {
      generatedAt: new Date(now).toISOString(),
      podIdentity: this.claim.identity(),
      queueMode,
      workerLoop: {
        leader: this.workerLoop.leader(),
        registeredTypes: this.workerLoop.registeredTypes(),
      },
      workerPool: {
        enabled: this.workerPool.enabled(),
        ...this.workerPool.stats(),
      },
      leaderLeases: leaderLeases.map((row) => {
        const expiresInMs = Date.parse(row.leaseUntil) - now;
        return {
          ...row,
          expired: expiresInMs < 0,
          expiresInSeconds: Math.round(expiresInMs / 1000),
        };
      }),
      activeClaims: activeClaims.map((row) => {
        const leaseInMs = Date.parse(row.leaseUntil) - now;
        const lastHeartbeatMs = now - Date.parse(row.heartbeatAt);
        return {
          ...row,
          leaseExpired: leaseInMs < 0,
          leaseExpiresInSeconds: Math.round(leaseInMs / 1000),
          lastHeartbeatSecondsAgo: Math.round(lastHeartbeatMs / 1000),
        };
      }),
    } satisfies LeasesResponse;
  }

  @Get('changefeed/state')
  @RequireScopes('brain:admin')
  async changefeedState() {
    const [stats, cursors] = await Promise.all([
      this.changefeed.stats(),
      this.changefeed.cursorState(),
    ]);
    return { stats, cursors };
  }

  @Post('changefeed/drain')
  @RequireScopes('brain:admin')
  async drainChangefeed() {
    return this.changefeed.drainNow();
  }
}
