import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../../auth/api-key.service';
import { SurrealService } from '../../db/surreal.service';
import {
  fitIsotonic,
  type CalibrationPair,
  type CalibrationMap,
} from './isotonic';
import {
  CalibrationService,
  BOOTSTRAP_PROMPT_HASH,
  BOOTSTRAP_PROMPT_KEY,
} from './calibration.service';
import { JobRunService } from '../../jobs/job-run.service';
import { JobClaimService } from '../../jobs/job-claim.service';
import { WorkerLoopService } from '../../jobs/worker-loop.service';
import { DistributedLeaseGuard } from '../../common/distributed-lease.guard';

/**
 * Phase 3.5 — nightly refit + source-trust recalculation.
 *
 * Two jobs in one service so they share the per-tenant iteration shell.
 *
 *   1. **source-trust refit** (03:42 UTC). Walks every tenant's
 *      knowledge_fact table, groups facts by `${vertical}:${recorder}`,
 *      counts `active` (wins) vs `superseded|retracted` (losses) per
 *      source key, and UPSERTs into `source_trust`. The Phase 2
 *      `fn::source_trust_for` SurrealDB function picks the learned
 *      rate up automatically once sampleCount ≥ 8.
 *
 *   2. **calibration refit** (03:51 UTC). Builds a (rawConfidence,
 *      correctness) gold set from the corpus: a fact whose
 *      `status === 'active'` AND `retractedAt IS NONE` is correctness=1;
 *      `superseded` or `retracted as supersede` within 30 days of
 *      ingest is correctness=0. PAV-fits a new map per (extractorModel,
 *      promptHash) pair and writes it as a new versioned row in
 *      `calibration_table`. CalibrationService.loadMap is called so
 *      the next request uses the refitted map without a restart.
 *
 * Both jobs are tenant-aware: one tenant's failure logs and is
 * skipped without breaking the rest.
 *
 * Schedule offsets (03:42 and 03:51 UTC) are inside the daily quiet
 * window already shared by CompactionService (03:17) and DreamsService
 * (04:00), so we don't fight any other write pass.
 */
@Injectable()
export class CalibrationRefitService implements OnModuleInit {
  private readonly logger = new Logger(CalibrationRefitService.name);
  private readonly enabled: boolean;
  private readonly extractorModel: string;
  // Canonical hashed key shared with CalibrationService — see
  // BOOTSTRAP_PROMPT_HASH. Persisting under the literal 'bootstrap' while
  // the loader read the hash meant nightly refits never reloaded on boot.
  private readonly bootstrapPromptKey = BOOTSTRAP_PROMPT_HASH;
  /**
   * Two sub-jobs (source-trust at 03:42, calibration at 03:51) share
   * one guard so the second tick can't start while the first is still
   * draining a huge tenant — and the manual trigger from
   * /admin/maintenance/calibration-refit can't overlap with either.
   */
  private readonly guard = new DistributedLeaseGuard();

  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    private readonly calibration: CalibrationService,
    private readonly config: ConfigService,
    @Optional() private readonly jobs?: JobRunService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
  ) {
    this.enabled =
      (config.get<string>('CALIBRATION_NIGHTLY_REFIT', 'true').toLowerCase()) ===
      'true';
    this.extractorModel = config.get<string>(
      'OPENAI_CHAT_MODEL',
      'gpt-4o-mini',
    );
  }

  onModuleInit(): void {
    if (!this.workerLoop) return;
    this.workerLoop.register(
      'source_trust_refit',
      async (ctx) => {
        // Cross-tenant single-row job — the refit walks all tenants.
        const upserted = await this.refitSourceTrustInner(
          {
            triggeredBy: 'cron',
            triggeredByActor: ctx.workerId,
          },
          { skipJobRowLifecycle: true },
        );
        return { upserted };
      },
      { ttlSeconds: 600, maxAttempts: 2 },
    );
    this.workerLoop.register(
      'calibration_refit',
      async (ctx) => {
        const sampleCount = await this.refitCalibrationInner(
          {
            triggeredBy: 'cron',
            triggeredByActor: ctx.workerId,
          },
          { skipJobRowLifecycle: true },
        );
        return { sampleCount };
      },
      { ttlSeconds: 600, maxAttempts: 2 },
    );
  }

  /**
   * Cron entry — source-trust refit at 03:42 UTC. Queue mode enqueues
   * a single cross-tenant row (the refit walks every tenant
   * internally). Date-keyed dedupKey absorbs a second firing during
   * leader transition.
   */
  @Cron('42 3 * * *', { timeZone: 'UTC' })
  async refitSourceTrustDaily(): Promise<number | { enqueued: boolean }> {
    if (!this.enabled) return 0;
    if (this.claim && this.queueModeEnabled()) {
      return this.enqueueRefit('source_trust_refit');
    }
    return this.refitSourceTrust();
  }

  /** Cron entry — calibration refit at 03:51 UTC. */
  @Cron('51 3 * * *', { timeZone: 'UTC' })
  async refitCalibrationDaily(): Promise<number | { enqueued: boolean }> {
    if (!this.enabled) return 0;
    if (this.claim && this.queueModeEnabled()) {
      return this.enqueueRefit('calibration_refit');
    }
    return this.refitCalibration();
  }

  private queueModeEnabled(): boolean {
    return (
      (this.config.get<string>('JOBS_QUEUE_MODE', 'enqueue') ?? 'enqueue') ===
      'enqueue'
    );
  }

  private async enqueueRefit(
    jobType: 'source_trust_refit' | 'calibration_refit',
  ): Promise<{ enqueued: boolean }> {
    // Both refits are CROSS-tenant single jobs (the inner method walks
    // every tenant). Use the first known tenant as the row's home —
    // matches the existing inline-path behaviour (see hostTenant in
    // refitSourceTrustInner / refitCalibrationInner).
    const hostTenant = this.apiKeys.knownCompanyIds()[0];
    if (!hostTenant) {
      this.logger.warn(`enqueue ${jobType} skipped — no known tenants`);
      return { enqueued: false };
    }
    const today = new Date().toISOString().slice(0, 10);
    try {
      const { created } = await this.claim!.enqueue({
        jobType,
        companyId: hostTenant,
        triggeredBy: 'cron',
        dedupKey: `${jobType}_${today}`,
      });
      this.logger.log(
        `${jobType} cron ${created ? 'enqueued' : 'collapsed (already enqueued)'} for ${today}`,
      );
      return { enqueued: created };
    } catch (e) {
      this.logger.warn(
        `enqueue ${jobType} failed: ${(e as Error).message}`,
      );
      return { enqueued: false };
    }
  }

  // ── Source-trust pass ────────────────────────────────────────────

  async refitSourceTrust(
    trigger?: {
      triggeredBy?: 'cron' | 'manual' | 'startup';
      triggeredByActor?: string;
    },
  ): Promise<number> {
    const guarded = await this.guard.run('refit_source_trust', () =>
      this.refitSourceTrustInner(trigger),
    );
    if (guarded === null) {
      this.logger.warn('source-trust refit skipped — already in flight');
      return 0;
    }
    return guarded;
  }

  private async refitSourceTrustInner(
    trigger?: {
      triggeredBy?: 'cron' | 'manual' | 'startup';
      triggeredByActor?: string;
    },
    opts?: { skipJobRowLifecycle?: boolean },
  ): Promise<number> {
    const tenants = this.apiKeys.knownCompanyIds();
    let upserted = 0;
    const hostTenant = tenants[0];
    let jobRow = null as null | Awaited<ReturnType<JobRunService['start']>>;
    if (hostTenant && this.jobs && !opts?.skipJobRowLifecycle) {
      try {
        jobRow = await this.jobs.start({
          jobType: 'source_trust_refit',
          companyId: hostTenant,
          triggeredBy: trigger?.triggeredBy ?? 'cron',
          triggeredByActor: trigger?.triggeredByActor,
        });
      } catch (e) {
        this.logger.warn(
          `source-trust job_run start failed: ${(e as Error).message}`,
        );
      }
    }
    try {
      for (const companyId of tenants) {
        try {
          upserted += await this.refitSourceTrustForTenant(companyId);
          if (jobRow) {
            await this.jobs?.updateProgress(jobRow, {
              currentTenant: companyId,
              upserted,
            });
          }
        } catch (e) {
          this.logger.warn(
            `source-trust refit failed for ${companyId}: ${(e as Error).message}`,
          );
        }
      }
      this.logger.log(
        `source-trust refit done — ${upserted} row(s) upserted across ${tenants.length} tenant(s)`,
      );
      if (jobRow) {
        await this.jobs?.finish(jobRow, {
          status: 'succeeded',
          result: { upserted, tenants: tenants.length },
        });
      }
      return upserted;
    } catch (e) {
      if (jobRow) {
        await this.jobs?.finish(jobRow, {
          status: 'failed',
          error: { message: (e as Error).message, name: (e as Error).name },
        });
      }
      throw e;
    }
  }

  private async refitSourceTrustForTenant(companyId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      // Fetch per-fact source + status. Aggregation lives in TS so
      // SurrealQL stays simple (one SELECT, one index seek) and the
      // aggregation logic is unit-testable via `aggregateBySourceKey`.
      const [rows] = await db.query<
        [
          Array<{
            vertical: string | null;
            recorder: string | null;
            status: string;
          }>,
        ]
      >(
        // recordedAt is projected explicitly: with aliased columns in the
        // SELECT, SurrealDB's ORDER BY resolver only sees the projection, so
        // ordering by an un-projected field silently breaks the query (same
        // alias/ORDER BY quirk noted in entities.service). Keep the alias for
        // the consumed columns and surface recordedAt so the sort resolves.
        `SELECT
            source.vertical AS vertical,
            source.recorder AS recorder,
            status,
            recordedAt
          FROM knowledge_fact
          WHERE source.vertical IS NOT NONE
          ORDER BY recordedAt DESC
          LIMIT 50000;`,
      );
      const events = (rows ?? []).map((r) => ({
        sourceKey: `${r.vertical}:${r.recorder ?? '_'}`,
        win: r.status === 'active' ? 1 : 0,
        loss: r.status === 'superseded' || r.status === 'retracted' ? 1 : 0,
      }));
      const summary = aggregateBySourceKey(events);

      let upsertedHere = 0;
      for (const { sourceKey, wins, losses } of summary) {
        const sampleCount = wins + losses;
        if (sampleCount === 0) continue;
        const rate = wins / sampleCount;
        await db.query(
          `LET $existing = (SELECT id FROM source_trust
              WHERE sourceKey = $k LIMIT 1)[0];
           IF $existing IS NONE THEN
             CREATE source_trust CONTENT {
               sourceKey: $k,
               agreementRate: $r,
               sampleCount: $sc,
               lastUpdated: time::now()
             }
           ELSE
             UPDATE $existing.id SET
               agreementRate = $r,
               sampleCount = $sc,
               lastUpdated = time::now()
           END;`,
          { k: sourceKey, r: rate, sc: sampleCount },
        );
        upsertedHere++;
      }
      return upsertedHere;
    });
  }

  // ── Calibration pass ─────────────────────────────────────────────

  async refitCalibration(
    trigger?: {
      triggeredBy?: 'cron' | 'manual' | 'startup';
      triggeredByActor?: string;
    },
  ): Promise<number> {
    const guarded = await this.guard.run('refit_calibration', () =>
      this.refitCalibrationInner(trigger),
    );
    if (guarded === null) {
      this.logger.warn('calibration refit skipped — already in flight');
      return 0;
    }
    return guarded;
  }

  private async refitCalibrationInner(
    trigger?: {
      triggeredBy?: 'cron' | 'manual' | 'startup';
      triggeredByActor?: string;
    },
    opts?: { skipJobRowLifecycle?: boolean },
  ): Promise<number> {
    const tenants = this.apiKeys.knownCompanyIds();
    const hostTenant = tenants[0];
    let jobRow = null as null | Awaited<ReturnType<JobRunService['start']>>;
    if (hostTenant && this.jobs && !opts?.skipJobRowLifecycle) {
      try {
        jobRow = await this.jobs.start({
          jobType: 'calibration_refit',
          companyId: hostTenant,
          triggeredBy: trigger?.triggeredBy ?? 'cron',
          triggeredByActor: trigger?.triggeredByActor,
        });
      } catch (e) {
        this.logger.warn(
          `calibration_refit job_run start failed: ${(e as Error).message}`,
        );
      }
    }
    try {
      const allPairs: CalibrationPair[] = [];
      for (const companyId of tenants) {
        try {
          const pairs = await this.collectCalibrationPairsForTenant(companyId);
          allPairs.push(...pairs);
          if (jobRow) {
            await this.jobs?.updateProgress(jobRow, {
              currentTenant: companyId,
              pairsCollected: allPairs.length,
            });
          }
        } catch (e) {
          this.logger.warn(
            `calibration pair collection failed for ${companyId}: ${(e as Error).message}`,
          );
        }
      }
      if (allPairs.length < 40) {
        const msg = `calibration refit skipped — only ${allPairs.length} pair(s) (need 40+)`;
        this.logger.log(msg);
        if (jobRow) {
          await this.jobs?.finish(jobRow, {
            status: 'succeeded',
            result: {
              skipped: true,
              skipReason: msg,
              pairsCollected: allPairs.length,
              floor: 40,
            },
          });
        }
        return 0;
      }
      const map = fitIsotonic(allPairs);
      await this.persistCalibrationMap(map);
      // loadMap re-hashes its promptText arg internally (cacheKey →
      // promptHashOf), and calibrate() reads with promptHashOf('bootstrap').
      // So pass the RAW literal here, NOT bootstrapPromptKey (which is the
      // already-hashed DB key) — otherwise the map lands under
      // promptHashOf(HASH) and the in-process hot-reload never hits.
      this.calibration.loadMap(this.extractorModel, BOOTSTRAP_PROMPT_KEY, map);
      this.logger.log(
        `calibration refit complete — samples=${map.sampleCount} bins=${map.thresholds.length}`,
      );
      if (jobRow) {
        await this.jobs?.finish(jobRow, {
          status: 'succeeded',
          result: {
            sampleCount: map.sampleCount,
            bins: map.thresholds.length,
          },
        });
      }
      return map.sampleCount;
    } catch (e) {
      if (jobRow) {
        await this.jobs?.finish(jobRow, {
          status: 'failed',
          error: { message: (e as Error).message, name: (e as Error).name },
        });
      }
      throw e;
    }
  }

  /**
   * Read persisted calibration_table versions for the active extractor
   * model. Operator-facing — surfaces the "what got persisted by the
   * nightly job" trail.
   */
  async listVersions(): Promise<
    Array<{
      version: number;
      sampleCount: number;
      bins: number;
      createdAt?: string;
    }>
  > {
    const tenants = this.apiKeys.knownCompanyIds();
    const host = tenants[0];
    if (!host) return [];
    return this.surreal.withCompany(host, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            version: number;
            sampleCount: number;
            thresholds: number[];
            createdAt?: string;
          }>,
        ]
      >(
        `SELECT version, sampleCount, thresholds, createdAt
            FROM calibration_table
            WHERE extractorModel = $m AND promptHash = $p
            ORDER BY version DESC LIMIT 50`,
        { m: this.extractorModel, p: this.bootstrapPromptKey },
      );
      return (rows ?? []).map((r) => ({
        version: r.version,
        sampleCount: r.sampleCount,
        bins: r.thresholds?.length ?? 0,
        createdAt: r.createdAt
          ? new Date(r.createdAt).toISOString()
          : undefined,
      }));
    });
  }

  private async collectCalibrationPairsForTenant(
    companyId: string,
  ): Promise<CalibrationPair[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            confidence: number;
            status: string;
            retractedAt: string | null;
            retractionReason: string | null;
          }>,
        ]
      >(
        `SELECT confidence, status, retractedAt, retractionReason, recordedAt
            FROM knowledge_fact
            WHERE confidence IS NOT NONE
              AND time::now() - recordedAt > 30d
            ORDER BY recordedAt DESC
            LIMIT 5000;`,
      );
      const pairs: CalibrationPair[] = [];
      for (const r of rows ?? []) {
        const conf = clamp01(Number(r.confidence));
        if (!Number.isFinite(conf)) continue;
        const correctness = isCorrect(r) ? 1 : 0;
        pairs.push({ rawConfidence: conf, correctness });
      }
      return pairs;
    });
  }

  private async persistCalibrationMap(map: CalibrationMap): Promise<void> {
    // Persist into the operator tenant's namespace. We pick the first
    // known tenant as the home for the global row — the table is
    // logically one-per-(model, promptHash, version) and tenant
    // namespacing for it isn't meaningful at Phase 3.5 scale.
    const tenants = this.apiKeys.knownCompanyIds();
    const host = tenants[0];
    if (!host) {
      this.logger.warn(
        'calibration persist skipped — no known tenants to host the row',
      );
      return;
    }
    await this.surreal.withCompany(host, async (db) => {
      const [latest] = await db.query<[Array<{ version: number }>]>(
        `SELECT version FROM calibration_table
            WHERE extractorModel = $m AND promptHash = $p
            ORDER BY version DESC LIMIT 1`,
        { m: this.extractorModel, p: this.bootstrapPromptKey },
      );
      const next =
        Array.isArray(latest) && latest[0]?.version
          ? latest[0].version + 1
          : 2;
      await db.query(
        `CREATE calibration_table CONTENT {
            extractorModel: $m,
            promptHash: $p,
            thresholds: $t,
            values: $v,
            sampleCount: $sc,
            version: $version
         }`,
        {
          m: this.extractorModel,
          p: this.bootstrapPromptKey,
          t: map.thresholds,
          v: map.values,
          sc: map.sampleCount,
          version: next,
        },
      );
    });
  }
}

// ── Pure helpers (exported for unit tests) ─────────────────────────

/**
 * A fact's "correctness" for calibration purposes: still active and
 * not retracted as a supersede within the gold window. The 30-day
 * window matches the FaithfulRAG bootstrap recipe — retractions
 * beyond that fold into noise.
 *
 * SURVIVORSHIP BIAS (intentional, documented): the final `return true`
 * means a fact that was never retracted or superseded counts as correct
 * even though nobody actively VALIDATED it — silence is read as success.
 * This skews calibration optimistic, since the negatives are only the
 * facts the system later overturned, not every fact that was wrong-but-
 * unchallenged. We keep it deliberately: it mirrors the FaithfulRAG
 * weak-supervision recipe (overturned == incorrect, survived == correct),
 * and the alternative (default false) would label the large unvalidated
 * majority as wrong and collapse the calibration map toward 0. Revisit if
 * an explicit human-verification signal becomes available to ground the
 * positives instead of inferring them from non-retraction.
 */
export function isCorrect(row: {
  status: string;
  retractedAt: string | null;
  retractionReason: string | null;
}): boolean {
  if (row.status === 'active' && row.retractedAt === null) return true;
  if (row.retractionReason === 'superseded') return false;
  if (row.status === 'retracted') return false;
  if (row.status === 'superseded') return false;
  return true;
}

/**
 * Roll up per-row {win, loss} tuples into {wins, losses} per
 * sourceKey. Exported so the unit test can exercise the math
 * without a SurrealDB round-trip.
 */
export function aggregateBySourceKey(
  rows: ReadonlyArray<{ sourceKey: string; win: number; loss: number }>,
): Array<{ sourceKey: string; wins: number; losses: number }> {
  const byKey = new Map<string, { wins: number; losses: number }>();
  for (const r of rows) {
    const acc = byKey.get(r.sourceKey) ?? { wins: 0, losses: 0 };
    acc.wins += r.win;
    acc.losses += r.loss;
    byKey.set(r.sourceKey, acc);
  }
  return [...byKey.entries()].map(([sourceKey, v]) => ({
    sourceKey,
    wins: v.wins,
    losses: v.losses,
  }));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
