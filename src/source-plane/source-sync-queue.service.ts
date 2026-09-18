import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { sourcePlaneEnabled } from '../common/source-plane-flags';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, type JobContext } from '../jobs/worker-loop.service';
import { idTailOf } from '../ingest/ingest-utils';
import { RecordsWebhookService, type WebhookJobPayload } from './records/records-webhook.service';
import { SourceSyncService } from './source-sync.service';

/**
 * SourceSyncQueueService — the jobs plumbing of the source plane, in
 * the registry-mirror / candidate-sweeper mold: onModuleInit register +
 * cron-time enqueue + queue handler. The runner (SourceSyncService)
 * knows nothing about jobs; this class knows nothing about syncing.
 *
 * Scheduling: every 5 minutes, for every tenant on the fan-out roster,
 * the connections whose `schedule` says they are due get ONE job each,
 * deduped per (connection, 5-minute slot) so overlapping ticks and
 * replicas collapse. `manual` connections are only ever synced by an
 * operator's sync-now. Flag off ⇒ no handler is registered and the cron
 * enqueues nothing — byte-identical.
 */
@Injectable()
export class SourceSyncQueueService implements OnModuleInit {
  private readonly logger = new Logger(SourceSyncQueueService.name);

  // eslint-disable-next-line max-params
  constructor(
    private readonly sync: SourceSyncService,
    private readonly apiKeys: ApiKeyService,
    private readonly webhooks: RecordsWebhookService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  onModuleInit(): void {
    if (!this.workerLoop || !sourcePlaneEnabled()) return;
    this.workerLoop.register(
      'source_sync',
      (ctx) => this.executeFromQueue(ctx),
      // A walk plus bounded fetches with LLM extraction per document;
      // the lease renews on heartbeat, the cap is the abort backstop.
      { ttlSeconds: 1800, maxAttempts: 2 },
    );
  }

  /** Enqueue one connection's sync; dedup per (connection, minute slot). */
  async enqueue(
    companyId: string,
    p: { connectionId: string; full?: boolean | undefined; triggeredBy: 'cron' | 'manual' },
  ): Promise<{ runId: string; created: boolean } | null> {
    if (!this.claim) return null;
    const slot = Math.floor(Date.now() / 300_000);
    return this.claim.enqueue({
      jobType: 'source_sync',
      companyId,
      triggeredBy: p.triggeredBy,
      dedupKey: `source_sync_${idTailOf(p.connectionId)}_${slot}`,
      payload: { connectionId: p.connectionId, full: p.full === true },
    });
  }

  /** Every 5 minutes at :02 — a minute no other cron uses. */
  @Cron('2-59/5 * * * *', { timeZone: 'UTC' })
  async runScheduled(): Promise<{ enqueued: number }> {
    if (!this.claim || !sourcePlaneEnabled()) return { enqueued: 0 };
    const now = new Date();
    let enqueued = 0;
    for (const companyId of this.apiKeys.fanOutRoster()) {
      let due;
      try {
        due = await this.sync.dueConnections(companyId, now);
      } catch (e) {
        this.logger.warn(`due-connections read for ${companyId} failed: ${(e as Error).message}`);
        continue;
      }
      for (const row of due) {
        try {
          const r = await this.enqueue(companyId, {
            connectionId: String(row.id),
            triggeredBy: 'cron',
          });
          if (r?.created) enqueued++;
        } catch (e) {
          this.logger.warn(
            `enqueue source_sync ${String(row.id)} for ${companyId} failed: ${(e as Error).message}`,
          );
        }
      }
    }
    return { enqueued };
  }

  /**
   * One queued `source_sync` job: a walk (the payload names the
   * connection and whether it is full) or a webhook batch (the payload
   * carries the events a vendor's call named — W4.2c, `ranBy: webhook`).
   * Public so a test can run a queued job without the worker loop.
   */
  async executeFromQueue(ctx: JobContext): Promise<Record<string, unknown>> {
    const connectionId = String(ctx.payload?.connectionId ?? '');
    if (!connectionId) return { skipped: 'missing_connectionId' };
    const webhook = (ctx.payload as Partial<WebhookJobPayload> | undefined)?.webhook;
    if (webhook && Array.isArray(webhook.events)) {
      const summary = await this.webhooks.apply(ctx.companyId, {
        connectionId,
        webhook,
        signal: ctx.abortSignal,
      });
      return { ...summary, ranBy: 'webhook' };
    }
    const summary = await this.sync.sync(ctx.companyId, connectionId, {
      full: ctx.payload?.full === true,
      signal: ctx.abortSignal,
    });
    return { ...summary };
  }
}
