import { Injectable, Logger, Optional } from '@nestjs/common';
import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import { JobClaimService, type JobClaim } from './job-claim.service';
import { JobWorkerPool } from './job-worker-pool.service';
import { MetricsService } from '../metrics/metrics.service';
import type { RegisteredHandler } from './worker-loop.types';

/**
 * JobDispatcherService — runs a single claimed job to completion. Owns
 * the renew loop (which doubles as the cross-pod cancel poll), the
 * handler/worker-pool invocation, OTel consumer span, and the terminal
 * complete / fail / cancelled write. The poll loop + leader election live
 * in WorkerPollerService / WorkerLoopService, which pass the pod-shutdown
 * AbortSignal in. Splitting this out keeps every worker class ≤3 deps.
 */
@Injectable()
export class JobDispatcherService {
  private readonly logger = new Logger(JobDispatcherService.name);

  constructor(
    private readonly claim: JobClaimService,
    @Optional() private readonly workerPool?: JobWorkerPool,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Run a single claim. `shutdownSignal` propagates a pod shutdown into
   * the handler's own AbortController.
   *
   * OTel: extract the producer-side traceparent injected at enqueue
   * (when present) and run the whole dispatch inside that context so the
   * consumer span links back.
   */
  async dispatch(
    claim: JobClaim,
    reg: RegisteredHandler,
    shutdownSignal: AbortSignal,
  ): Promise<void> {
    const parentCtx = claim.traceparent
      ? propagation.extract(context.active(), {
          traceparent: claim.traceparent,
        })
      : context.active();
    return context.with(parentCtx, () =>
      this.dispatchInner(claim, reg, shutdownSignal),
    );
  }

  private async dispatchInner(
    claim: JobClaim,
    reg: RegisteredHandler,
    shutdownSignal: AbortSignal,
  ): Promise<void> {
    const tracer = trace.getTracer('inite-brain-service');
    const span = tracer.startSpan(`jobs.process ${claim.jobType}`, {
      attributes: {
        'messaging.system': 'surrealdb',
        'messaging.operation': 'process',
        'messaging.destination.name': claim.jobType,
        'messaging.destination.kind': 'queue',
        'messaging.message.id': claim.runId,
        'job.companyId': claim.companyId,
        'job.attempts': claim.attempts,
        'job.workerId': this.claim.identity(),
        'job.cpuBound': reg.cpuBound === true,
      },
    });
    try {
      await context.with(trace.setSpan(context.active(), span), () =>
        this.dispatchBody(claim, reg, span, shutdownSignal),
      );
    } finally {
      span.end();
    }
  }

  private async dispatchBody(
    claim: JobClaim,
    reg: RegisteredHandler,
    consumerSpan: ReturnType<ReturnType<typeof trace.getTracer>['startSpan']>,
    shutdownSignal: AbortSignal,
  ): Promise<void> {
    const handlerAbort = new AbortController();
    const startedAt = Date.now();
    // Mirrors the span's `job.outcome`. Defaults to 'failed' so an
    // unexpected throw before any branch is counted as a failure, not lost.
    let outcome: 'succeeded' | 'failed' | 'cancelled' | 'lost_claim' = 'failed';
    // Pod shutdown propagates into the handler.
    const onShutdown = () => handlerAbort.abort(new Error('pod_shutdown'));
    shutdownSignal.addEventListener('abort', onShutdown, { once: true });
    // Renew every ttl/3. The renew result tells us if the row was
    // reaped out from under us OR if an operator requested cancel.
    let cancelRequested = false;
    let lostClaim = false;
    const renewIntervalMs = Math.max(
      1000,
      Math.floor((reg.ttlSeconds * 1000) / 3),
    );
    const renewTimer = setInterval(() => {
      void (async () => {
        const r = await this.claim.renew({
          companyId: claim.companyId,
          recordId: claim.recordId,
          ttlSeconds: reg.ttlSeconds,
        });
        if (!r.stillOwned) {
          lostClaim = true;
          handlerAbort.abort(new Error('lost_claim'));
        } else if (r.cancelRequested && !cancelRequested) {
          cancelRequested = true;
          handlerAbort.abort(new Error('cancel_requested'));
        }
      })();
    }, renewIntervalMs);
    try {
      const ctx = {
        runId: claim.runId,
        jobType: claim.jobType,
        companyId: claim.companyId,
        payload: claim.payload,
        attempts: claim.attempts,
        abortSignal: handlerAbort.signal,
        workerId: this.claim.identity(),
      };
      const result =
        reg.cpuBound && reg.workerModule && this.workerPool?.enabled()
          ? await this.workerPool.run(reg.workerModule, {
              runId: ctx.runId,
              jobType: ctx.jobType,
              companyId: ctx.companyId,
              payload: ctx.payload,
              attempts: ctx.attempts,
              workerId: ctx.workerId,
            })
          : await reg.handler(ctx);
      clearInterval(renewTimer);
      if (cancelRequested) {
        consumerSpan.setAttribute('job.outcome', 'cancelled');
        outcome = 'cancelled';
        await this.claim.cancelled({
          companyId: claim.companyId,
          recordId: claim.recordId,
          result: (result as Record<string, unknown>) ?? undefined,
        });
      } else if (lostClaim) {
        // Don't write — another worker owns the row now. The
        // duplicate-work cost was already paid; just bail.
        consumerSpan.setAttribute('job.outcome', 'lost_claim');
        outcome = 'lost_claim';
        this.logger.warn(
          `Claim ${claim.runId} lost mid-handler; skipping terminal write`,
        );
      } else {
        consumerSpan.setAttribute('job.outcome', 'succeeded');
        outcome = 'succeeded';
        await this.claim.complete({
          companyId: claim.companyId,
          recordId: claim.recordId,
          result: (result as Record<string, unknown>) ?? undefined,
        });
      }
    } catch (err) {
      clearInterval(renewTimer);
      const e = err as Error;
      consumerSpan.recordException(e);
      if (cancelRequested) {
        consumerSpan.setAttribute('job.outcome', 'cancelled');
        outcome = 'cancelled';
        await this.claim.cancelled({
          companyId: claim.companyId,
          recordId: claim.recordId,
          result: { reason: 'cancel_requested', message: e.message },
        });
      } else if (lostClaim) {
        consumerSpan.setAttribute('job.outcome', 'lost_claim');
        outcome = 'lost_claim';
        this.logger.warn(
          `Claim ${claim.runId} lost mid-handler (handler threw): ${e.message}`,
        );
      } else {
        consumerSpan.setAttribute('job.outcome', 'failed');
        outcome = 'failed';
        consumerSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        await this.claim.fail({
          companyId: claim.companyId,
          recordId: claim.recordId,
          attempts: claim.attempts,
          error: { message: e.message, name: e.name },
          requeue: true,
          maxAttempts: reg.maxAttempts,
        });
      }
    } finally {
      shutdownSignal.removeEventListener('abort', onShutdown);
      const elapsed = (Date.now() - startedAt) / 1000;
      this.metrics?.recordJob(claim.jobType, outcome, elapsed);
    }
  }
}
