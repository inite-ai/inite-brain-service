import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { withSpan } from '../common/tracing';
import { DreamsDedupService, DedupResult } from './dedup.service';
import { DreamsResolverService, ResolverResult } from './resolver.service';
import { CompactionService } from '../compaction/compaction.service';
import {
  CommunityBuilderService,
  type CommunityBuildResult,
} from '../communities/community-builder.service';
import { DreamsOperation } from './dto/run-dreams.dto';
import { JobRunService, JobRunRow } from '../jobs/job-run.service';
import { JobClaimService } from '../jobs/job-claim.service';
import {
  WorkerLoopService,
  type JobContext,
} from '../jobs/worker-loop.service';
import { DistributedLeaseGuard } from '../common/distributed-lease.guard';

export interface DreamsTenantStats {
  companyId: string;
  durationSeconds: number;
  dedup?: DedupResult;
  resolve?: ResolverResult;
  /**
   * The summarize op delegates to CompactionService.compactCompany,
   * which uses the injected SUMMARY_GENERATOR. We surface a flag
   * here just so callers know it ran; the full compaction stats
   * stay accessible via the existing /metrics surface.
   */
  summarized?: boolean;
  /** Topic-community (re)build stats — present when the communities op ran. */
  communities?: CommunityBuildResult;
  error?: string;
}

/**
 * DreamsService — orchestrates the off-hours self-improvement pass:
 *
 *   1. (optional) Compaction with LLM summary generator → richer
 *      warm-tier rollups. Triggered explicitly via `summarize`
 *      operation; in practice the daily compaction cron already
 *      runs this if DREAMS_LLM_SUMMARY_ENABLED=1.
 *   2. Near-duplicate entity dedup → identity_of links emitted
 *      automatically when an LLM judge confirms the match.
 *   3. Competing-fact auto-resolution → loser fact superseded with
 *      `retractionReason='dreams_resolution'` when an LLM judge
 *      breaks the tie; ambiguous pairs left for the operator.
 *
 * Cron: daily at 04:00 UTC, 43 minutes after the compaction cron
 * (03:17). The lag is intentional — dreams operates over the post-
 * compaction state so fresh summaries land before dedup / resolve
 * pull their context.
 *
 * Per-tenant fan-out: errors on one tenant log + continue. The
 * orchestrator is read-mostly; a Surreal hiccup on tenant N must
 * not stop tenant N+1.
 */
@Injectable()
export class DreamsService implements OnModuleInit {
  private readonly logger = new Logger(DreamsService.name);
  private readonly enabled: boolean;
  private readonly defaultOps: ReadonlySet<DreamsOperation>;
  /**
   * Reentrancy guard. Keys: 'dreams_all' for the cross-tenant runAll
   * path, `dreams_tenant:${companyId}` for per-tenant runs. Distributed
   * via leader_lease so a multi-pod deploy elects ONE pod to run the
   * cron — the others see "lease held" and skip. Local in-flight
   * defence inside the guard still protects same-pod overlap (cron +
   * manual landing simultaneously).
   */

  // TODO: bundle Phase J/K trio (claim, workerLoop, jobs) into one
  // JobsDeps injectable so the param list drops back under the
  // max-params gate. Tracked separately to keep the gate working
  // for new code without ripping the DI tree.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    private readonly dedup: DreamsDedupService,
    private readonly resolver: DreamsResolverService,
    private readonly compaction: CompactionService,
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly jobs?: JobRunService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    // No default `= new DistributedLeaseGuard()`: that constructed a
    // lease-LESS guard that degraded to local-only single-flight, silently
    // bypassing the distributed lease and letting every pod run the dreams
    // cron at once. JobsModule is @Global, so production DI always injects
    // the properly-wired guard (carrying LeaderLeaseService). Stays
    // @Optional so the positional unit tests (no DI) can omit it — they run
    // unguarded, which is correct for single-process tests.
    @Optional() private readonly guard?: DistributedLeaseGuard,
    // @Optional so the positional unit tests (no DI) can omit it. In
    // production CommunityModule (imported by DreamsModule) provides it.
    @Optional() private readonly community?: CommunityBuilderService,
  ) {
    this.enabled =
      this.configService.get<string>('DREAMS_ENABLED', '0') === '1';
    // Default operation set: every sub-service that's been individually
    // enabled. An operator who only wants dedup flips
    // DREAMS_DEDUP_ENABLED=1 and DREAMS_ENABLED=1 — the cron then
    // skips the resolve / summarize legs.
    const ops: DreamsOperation[] = [];
    if (this.dedup.isEnabled()) ops.push('dedup');
    if (this.resolver.isEnabled()) ops.push('resolve');
    // summarize is always available because the no-LLM concat path
    // is the fallback; the LLM path engages when DREAMS_LLM_SUMMARY_ENABLED=1.
    if (
      this.configService.get<string>('DREAMS_RUN_SUMMARIZE', '0') === '1'
    ) {
      ops.push('summarize');
    }
    // Communities auto-join the default set when enabled (same pattern as
    // dedup/resolve — one flag, DREAMS_COMMUNITIES_ENABLED).
    if (this.community?.isEnabled()) ops.push('communities');
    this.defaultOps = new Set(ops);
    this.logger.log(
      `Dreams config: enabled=${this.enabled}, default ops=${[...this.defaultOps].join(',') || '(none)'}`,
    );
  }

  /**
   * Register the dreams handler with the worker loop. Called once at
   * boot — handler stays inert until the leader pod's worker loop
   * dequeues a `dreams` job.
   */
  onModuleInit(): void {
    if (!this.workerLoop) return;
    this.workerLoop.register(
      'dreams',
      (ctx) => this.executeFromQueue(ctx),
      // ttl: dreams can take ≥10min on large tenants (dedup LLM judge
      // + competing-fact resolution + summarize); 20min lease gives
      // 6 renew ticks of safety margin.
      { ttlSeconds: 1200, maxAttempts: 3 },
    );
  }

  /**
   * Cron entry — daily at 04:00 UTC, 43 min after compaction (03:17).
   *
   * Queue mode (JOBS_QUEUE_MODE=enqueue, default): JobClaimService
   * enqueues one row per known tenant with a date-keyed dedupKey so
   * a second cron firing during a leader transition collapses
   * cleanly. WorkerLoopService picks up rows on the leader pod.
   *
   * Inline mode (JOBS_QUEUE_MODE=inline, operator kill-switch): the
   * cron falls back to the original guarded runAll(). Use this to
   * roll back queue mode at runtime without redeploying — set the
   * env var, restart the container, the next cron firing executes
   * inline. Also the implicit fallback when JobClaimService isn't
   * wired (tests, single-pod dev without JobsModule).
   */
  @Cron('0 4 * * *', { timeZone: 'UTC' })
  async runDaily(): Promise<DreamsTenantStats[] | { enqueued: number }> {
    if (!this.enabled) return [];
    if (this.claim && this.queueModeEnabled()) {
      return this.enqueueDailyForAllTenants();
    }
    const result = this.guard
      ? await this.guard.run('dreams_all', () => this.runAll())
      : await this.runAll();
    if (result === null) {
      this.logger.warn(
        'dreams cron skipped — previous runAll still in flight',
      );
      return [];
    }
    return result;
  }

  private queueModeEnabled(): boolean {
    return (
      (this.configService.get<string>('JOBS_QUEUE_MODE', 'enqueue') ??
        'enqueue') === 'enqueue'
    );
  }

  /**
   * Cross-tenant cron-time enqueue. Idempotent across leader
   * transitions: dedupKey = `dreams_${YYYY-MM-DD}` so the unique
   * index on (jobType, dedupKey) collapses a second firing into the
   * first row instead of double-queueing.
   */
  private async enqueueDailyForAllTenants(): Promise<{ enqueued: number }> {
    const tenants = this.apiKeys.knownCompanyIds();
    const today = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const companyId of tenants) {
      try {
        const { created } = await this.claim!.enqueue({
          jobType: 'dreams',
          companyId,
          triggeredBy: 'cron',
          dedupKey: `dreams_${today}`,
          payload: { operations: [...this.defaultOps] },
        });
        if (created) enqueued++;
      } catch (e) {
        this.logger.warn(
          `enqueue dreams for ${companyId} failed: ${(e as Error).message}`,
        );
      }
    }
    this.logger.log(
      `Dreams cron enqueued ${enqueued}/${tenants.length} tenant job(s) for ${today}`,
    );
    return { enqueued };
  }

  /**
   * Handler entry point — runs the actual dreams pipeline for ONE
   * tenant as dispatched by the WorkerLoopService.
   *
   * Job-row lifecycle: managed by WorkerLoopService.dispatch (claimed
   * to 'running' on claimNext; written to 'succeeded'/'failed'/
   * 'cancelled' depending on this method's outcome). We never touch
   * the row directly — skipJobRowLifecycle=true tells the inner
   * method not to start()/finish() either.
   *
   * Cancellation: ctx.abortSignal fires when (a) an operator hit
   * /v1/admin/jobs/:id/cancel and the renew tick saw
   * cancelRequested=true, (b) we lost the claim (zombie reap took
   * it), or (c) the pod is shutting down. We check the signal
   * between dedup → resolve → summarize so an in-flight handler
   * exits cleanly within ttl/3 (~6.5min for ttlSeconds=1200).
   * Throwing here routes to cancelled() (not fail+requeue) inside
   * WorkerLoopService.dispatch.
   */
  async executeFromQueue(
    ctx: JobContext,
  ): Promise<Record<string, unknown>> {
    const opsRaw = ctx.payload?.operations as DreamsOperation[] | undefined;
    const ops = opsRaw && opsRaw.length ? opsRaw : [...this.defaultOps];
    this.throwIfAborted(ctx);
    const stats = await this.runForTenantInner(
      ctx.companyId,
      ops,
      { triggeredBy: 'cron', triggeredByActor: ctx.workerId },
      { skipJobRowLifecycle: true, abortSignal: ctx.abortSignal },
    );
    this.throwIfAborted(ctx);
    return {
      durationSeconds: stats.durationSeconds,
      identityLinksCreated: stats.dedup?.identityLinksCreated ?? 0,
      resolutionsApplied: stats.resolve?.resolutionsApplied ?? 0,
      summarized: stats.summarized ?? false,
      communitiesBuilt: stats.communities?.communitiesBuilt ?? 0,
    };
  }

  private throwIfAborted(ctx: JobContext): void {
    if (ctx.abortSignal.aborted) {
      throw ctx.abortSignal.reason ?? new Error('aborted');
    }
  }

  /**
   * Iterate every known tenant. One bad tenant must not stop the
   * rest — errors are logged and folded into the per-tenant stats.
   */
  async runAll(operations?: DreamsOperation[]): Promise<DreamsTenantStats[]> {
    const tenants = this.apiKeys.knownCompanyIds();
    const ops = operations ? new Set(operations) : this.defaultOps;
    this.logger.log(
      `Dreams starting — ${tenants.length} tenant(s), ops=${[...ops].join(',') || '(none)'}`,
    );
    const out: DreamsTenantStats[] = [];
    for (const companyId of tenants) {
      try {
        out.push(await this.runForTenant(companyId, [...ops]));
      } catch (err) {
        const e = err as Error;
        this.logger.error(`Dreams failed for ${companyId}: ${e.message}`);
        this.metrics?.countDreams('failed');
        out.push({
          companyId,
          durationSeconds: 0,
          error: e.message,
        });
      }
    }
    const totalDedupLinks = out.reduce(
      (acc, r) => acc + (r.dedup?.identityLinksCreated ?? 0),
      0,
    );
    const totalResolutions = out.reduce(
      (acc, r) => acc + (r.resolve?.resolutionsApplied ?? 0),
      0,
    );
    this.logger.log(
      `Dreams done — ${out.length} tenant(s), ${totalDedupLinks} identity link(s), ` +
        `${totalResolutions} resolution(s) applied`,
    );
    return out;
  }

  /**
   * Run one tenant. Wraps the SurrealDB connection acquisition so
   * each sub-service receives the same scoped handle. Operations
   * run sequentially — dedup tweaks the graph, which the resolver
   * then sees a cleaner context for. Order: dedup → resolve →
   * summarize.
   *
   * Also opens a job_run row + writes per-emit detail rows so the
   * admin UI has history + drill-down. Triggered context (`cron` /
   * `manual` / actor) is threaded through from the entry point.
   */
  async runForTenant(
    companyId: string,
    operations: DreamsOperation[],
    triggered?: {
      triggeredBy?: 'cron' | 'manual' | 'startup';
      triggeredByActor?: string;
    },
  ): Promise<DreamsTenantStats> {
    const guarded = this.guard
      ? await this.guard.run(`dreams_tenant_${companyId}`, () =>
          this.runForTenantInner(companyId, operations, triggered),
        )
      : await this.runForTenantInner(companyId, operations, triggered);
    if (guarded !== null) return guarded;
    this.logger.warn(
      `dreams skipped for ${companyId} — previous run still in flight`,
    );
    return {
      companyId,
      durationSeconds: 0,
      error: 'skipped: previous run still in flight',
    };
  }

  // TODO: complexity 28 — opSet branching across dedup/resolve/
  // summarize + jobRow lifecycle + abortSignal checks. Extract each
  // sub-leg into a helper (runDedupLeg, runResolveLeg, etc.) and
  // drop back under the gate. Tracked separately.
  // eslint-disable-next-line complexity
  private async runForTenantInner(
    companyId: string,
    operations: DreamsOperation[],
    triggered?: {
      triggeredBy?: 'cron' | 'manual' | 'startup';
      triggeredByActor?: string;
    },
    opts?: { skipJobRowLifecycle?: boolean; abortSignal?: AbortSignal },
  ): Promise<DreamsTenantStats> {
    const checkAbort = () => {
      if (opts?.abortSignal?.aborted) {
        throw opts.abortSignal.reason ?? new Error('aborted');
      }
    };
    const t0 = Date.now();
    const stats: DreamsTenantStats = {
      companyId,
      durationSeconds: 0,
    };
    const opSet = new Set(operations);
    // Queue mode (skipJobRowLifecycle): WorkerLoopService owns the
    // job_run row's lifecycle — already wrote claimedBy/leaseUntil on
    // claim, will write status='succeeded'/'failed' on dispatch return.
    // We skip start()/finish() to avoid double-row + double-terminal.
    let jobRow: JobRunRow | null = null;
    if (!opts?.skipJobRowLifecycle) {
      try {
        jobRow =
          (await this.jobs?.start({
            jobType: 'dreams',
            companyId,
            triggeredBy: triggered?.triggeredBy ?? 'cron',
            triggeredByActor: triggered?.triggeredByActor,
            initialProgress: { operations: [...opSet] },
          })) ?? null;
      } catch (e) {
        this.logger.warn(
          `dreams job_run start failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }

    try {
      await this.surreal.withCompany(companyId, async (db) => {
        if (opSet.has('dedup')) {
          checkAbort();
          stats.dedup = await withSpan(
            'dreams.dedup',
            () => this.dedup.run(db),
            { 'dreams.tenant': companyId },
          );
          if (jobRow) {
            await this.jobs?.updateProgress(jobRow, {
              currentTenant: companyId,
              dedupLinksCreated: stats.dedup.identityLinksCreated,
            });
          }
        }
        if (opSet.has('resolve')) {
          checkAbort();
          stats.resolve = await withSpan(
            'dreams.resolve',
            () => this.resolver.run(db),
            { 'dreams.tenant': companyId },
          );
          if (jobRow) {
            await this.jobs?.updateProgress(jobRow, {
              resolutionsApplied: stats.resolve.resolutionsApplied,
            });
          }
        }
        if (opSet.has('communities') && this.community) {
          checkAbort();
          stats.communities = await withSpan(
            'dreams.communities',
            () => this.community!.run(db),
            { 'dreams.tenant': companyId },
          );
          if (jobRow) {
            await this.jobs?.updateProgress(jobRow, {
              communitiesBuilt: stats.communities.communitiesBuilt,
              communitiesReused: stats.communities.communitiesReused,
            });
          }
        }
        if (jobRow) {
          await this.writeEmits(db, jobRow.runId, stats);
        }
      });

      if (opSet.has('summarize')) {
        checkAbort();
        // Compaction owns its own connection lifecycle (it iterates
        // over knowledge_fact in batches and updates statuses), so we
        // delegate rather than threading the existing db handle in.
        try {
          await withSpan(
            'dreams.summarize',
            () => this.compaction.compactCompany(companyId),
            { 'dreams.tenant': companyId },
          );
          stats.summarized = true;
        } catch (err) {
          this.logger.warn(
            `Dreams summarize failed for ${companyId}: ${(err as Error).message}`,
          );
          stats.summarized = false;
        }
      }

      stats.durationSeconds = (Date.now() - t0) / 1000;
      this.metrics?.countDreams('ok');
      if (stats.dedup) {
        this.metrics?.countDreamsEmitted(
          'identity_link',
          stats.dedup.identityLinksCreated,
        );
      }
      if (stats.resolve) {
        this.metrics?.countDreamsEmitted(
          'resolution',
          stats.resolve.resolutionsApplied,
        );
      }
      if (stats.summarized) {
        this.metrics?.countDreamsEmitted('summary', 1);
      }
      if (jobRow) {
        await this.jobs?.finish(jobRow, {
          status: 'succeeded',
          result: {
            durationSeconds: stats.durationSeconds,
            identityLinksCreated: stats.dedup?.identityLinksCreated ?? 0,
            resolutionsApplied: stats.resolve?.resolutionsApplied ?? 0,
            summarized: stats.summarized ?? false,
          },
        });
      }
      return stats;
    } catch (err) {
      const e = err as Error;
      if (jobRow) {
        await this.jobs?.finish(jobRow, {
          status: 'failed',
          error: { message: e.message, name: e.name },
        });
      }
      throw err;
    }
  }

  /**
   * Persist per-emit rows so the admin UI can answer "which merges
   * did dream produce in this run?". Best-effort: a failure to write
   * detail doesn't fail the run — the aggregate counters in
   * job_run.result are the source of truth.
   */
  private async writeEmits(
    db: any,
    runId: string,
    stats: DreamsTenantStats,
  ): Promise<void> {
    try {
      for (const link of stats.dedup?.identityLinks ?? []) {
        await db.query(
          `CREATE dream_emit CONTENT {
             runId: $runId, kind: 'identity_link',
             subject: $subject, object: $object,
             detail: $detail
           }`,
          {
            runId,
            subject: link.survivorId ?? null,
            object: link.loserId ?? null,
            detail: link,
          },
        );
      }
      for (const res of stats.resolve?.resolutions ?? []) {
        await db.query(
          `CREATE dream_emit CONTENT {
             runId: $runId, kind: 'resolution',
             subject: $subject, object: $object,
             detail: $detail
           }`,
          {
            runId,
            subject: res.winnerFactId ?? null,
            object: res.loserFactId ?? null,
            detail: res,
          },
        );
      }
    } catch (e) {
      this.logger.warn(
        `dream_emit write failed (${runId}): ${(e as Error).message}`,
      );
    }
  }
}
