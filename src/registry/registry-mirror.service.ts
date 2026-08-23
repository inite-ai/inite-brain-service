import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, JobContext } from '../jobs/worker-loop.service';
import { PackRegistryService } from './pack-registry.service';
import {
  normalizeUpstreamBase,
  syncRegistryMirror,
  type MirrorLocalRegistry,
  type MirrorSyncSummary,
} from './registry-mirror-sync';

/**
 * Pull-only cross-instance registry mirroring (docs/domain-packs.md).
 *
 * When REGISTRY_UPSTREAM_URL is set, a background job periodically pulls the
 * upstream instance's pack catalogue and republishes versions missing locally
 * with an `origin` marker (migration 0064). Pull-only: local publishes never
 * push upstream; yanks mirror one-way (upstream yank → local yank, and only
 * onto rows whose origin matches this upstream). The merge rules live in
 * registry-mirror-sync.ts; this class owns config, scheduling and the
 * jobs-framework plumbing (candidate-sweeper mold: onModuleInit register +
 * cron-time enqueue + queue handler).
 *
 * Unset REGISTRY_UPSTREAM_URL (the default) = feature off: no handler is
 * registered, the cron enqueues nothing — zero behavior change.
 *
 * Tenancy: the registry is INSTANCE-GLOBAL (PackRegistryService writes the
 * shared `system` DB via withAdminDb), but the jobs framework is strictly
 * per-tenant — every job_run row lives in one tenant DB. Same adaptation as
 * the cross-tenant source-trust refit (CalibrationRefitQueueService): the
 * cron enqueues a SINGLE row homed on the first known tenant, and the
 * handler does instance-global work regardless of the row's tenant.
 *
 * Cadence: the cron ticks hourly at :26 UTC (a minute no other cron uses)
 * and enqueues with a dedup key derived from the current
 * REGISTRY_MIRROR_INTERVAL_HOURS bucket, so extra ticks inside one interval
 * collapse against the bucket's run. With the default 24h interval the
 * bucket flips at midnight UTC → one run at 00:26 UTC, clear of the
 * 03:17–04:00 nightly maintenance window.
 */
@Injectable()
export class RegistryMirrorService implements OnModuleInit {
  private readonly logger = new Logger(RegistryMirrorService.name);

  // Job-owner service in the candidate-sweeper mold: registration,
  // cron-time enqueue, and the sync entrypoint.
  // eslint-disable-next-line max-params
  constructor(
    private readonly registry: PackRegistryService,
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  onModuleInit(): void {
    // Feature off (no upstream configured) → nothing registered, the
    // worker loop never polls for registry_mirror rows.
    if (!this.upstreamUrl() || !this.workerLoop) return;
    this.workerLoop.register('registry_mirror', (ctx) => this.executeFromQueue(ctx), {
      ttlSeconds: 600,
      maxAttempts: 2,
    });
  }

  /** Hourly at :26 UTC — the interval-bucketed dedup key collapses ticks
   *  inside one REGISTRY_MIRROR_INTERVAL_HOURS window into a single run. */
  @Cron('26 * * * *', { timeZone: 'UTC' })
  async runScheduled(): Promise<{ enqueued: boolean }> {
    const upstream = this.upstreamUrl();
    if (!upstream || !this.claim) return { enqueued: false };
    const hostTenant = this.apiKeys.knownCompanyIds()[0];
    if (!hostTenant) {
      this.logger.warn('registry_mirror enqueue skipped — no known tenants');
      return { enqueued: false };
    }
    const intervalMs = this.intervalHours() * 3_600_000;
    const bucketStart = new Date(Math.floor(Date.now() / intervalMs) * intervalMs);
    // Date-keyed (bucket-start date + hour): registry_mirror_2026-07-15T00
    const dedupKey = `registry_mirror_${bucketStart.toISOString().slice(0, 13)}`;
    try {
      const { created } = await this.claim.enqueue({
        jobType: 'registry_mirror',
        companyId: hostTenant,
        triggeredBy: 'cron',
        dedupKey,
      });
      if (created) {
        this.logger.log(`registry_mirror enqueued (${dedupKey}, upstream ${upstream})`);
      }
      return { enqueued: created };
    } catch (e) {
      this.logger.warn(`enqueue registry_mirror failed: ${(e as Error).message}`);
      return { enqueued: false };
    }
  }

  /** Run one pull-sync against the configured upstream. */
  async sync(signal?: AbortSignal): Promise<MirrorSyncSummary> {
    const upstream = this.upstreamUrl();
    if (!upstream) {
      throw new Error('REGISTRY_UPSTREAM_URL is not set — mirroring is off');
    }
    return syncRegistryMirror({
      upstreamBase: upstream,
      token: process.env.REGISTRY_UPSTREAM_TOKEN,
      local: this.localPort(upstream),
      logger: {
        log: (m) => this.logger.log(m),
        warn: (m) => this.logger.warn(m),
        debug: (m) => this.logger.debug(m),
      },
      signal,
    });
  }

  private async executeFromQueue(ctx: JobContext): Promise<Record<string, unknown>> {
    const summary = await this.sync(ctx.abortSignal);
    return { ...summary };
  }

  /** The sync core's port onto the LOCAL registry — the same publish/yank
   *  paths operators use, so every invariant (validation, builtin-id
   *  squatting protection, immutability, local trust-store `verified`
   *  recomputation, signed-packs policy) applies to mirrored rows too. */
  private localPort(upstream: string): MirrorLocalRegistry {
    return {
      versionsOf: async (packId) => {
        const { versions } = await this.registry.getVersions(packId);
        return versions.map((v) => ({
          version: v.version,
          yanked: v.yanked,
          origin: v.origin ?? null,
        }));
      },
      publish: (input) =>
        this.registry.publish({
          manifest: input.manifest,
          origin: input.origin,
          expectedChecksum: input.expectedChecksum,
          publishedBy: `mirror:${upstream}`,
        }),
      yank: async (input) => {
        await this.registry.yank(input.packId, input.version, input.reason);
      },
    };
  }

  private upstreamUrl(): string | undefined {
    const raw = process.env.REGISTRY_UPSTREAM_URL?.trim();
    return raw ? normalizeUpstreamBase(raw) : undefined;
  }

  private intervalHours(): number {
    const raw = process.env.REGISTRY_MIRROR_INTERVAL_HOURS;
    const n = raw === undefined ? NaN : parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 24;
  }
}
