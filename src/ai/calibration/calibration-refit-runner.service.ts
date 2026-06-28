import { Injectable, Logger } from '@nestjs/common';
import { ApiKeyService } from '../../auth/api-key.service';
import { SurrealService } from '../../db/surreal.service';
import {
  fitIsotonic,
  type CalibrationPair,
  type CalibrationMap,
} from './isotonic';
import { CalibrationService, BOOTSTRAP_PROMPT_HASH, BOOTSTRAP_PROMPT_KEY } from './calibration.service';

/** Per-tenant progress callback so the caller can track a job_run row. */
export type RefitProgress = (detail: Record<string, unknown>) => void;

export interface RefitOutcome {
  /** The headline count returned to the caller (upserted / sampleCount). */
  count: number;
  /** The rich payload persisted on the job_run row's success result. */
  result: Record<string, unknown>;
}

/**
 * CalibrationRefitRunnerService — the nightly refit engine.
 *
 * Owns the actual work, free of cron/queue/job-tracking concerns:
 *   - source-trust refit: walk every tenant, group facts by source key,
 *     UPSERT learned agreement rates into source_trust.
 *   - calibration refit: build a (rawConfidence, correctness) gold set
 *     across tenants, PAV-fit a new map, persist + hot-reload it.
 *
 * Both methods take an optional per-tenant progress callback so the
 * orchestrator can mirror progress onto a job_run row. extractorModel is
 * read from the environment so the runner carries no ConfigService dep,
 * keeping it at ≤3 (surreal, calibration, apiKeys).
 */
@Injectable()
export class CalibrationRefitRunnerService {
  private readonly logger = new Logger(CalibrationRefitRunnerService.name);
  private readonly extractorModel =
    process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini';
  private readonly bootstrapPromptKey = BOOTSTRAP_PROMPT_HASH;

  constructor(
    private readonly surreal: SurrealService,
    private readonly calibration: CalibrationService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async refitSourceTrust(onProgress?: RefitProgress): Promise<RefitOutcome> {
    const tenants = this.apiKeys.knownCompanyIds();
    let upserted = 0;
    for (const companyId of tenants) {
      try {
        upserted += await this.refitSourceTrustForTenant(companyId);
        onProgress?.({ currentTenant: companyId, upserted });
      } catch (e) {
        this.logger.warn(
          `source-trust refit failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    this.logger.log(
      `source-trust refit done — ${upserted} row(s) upserted across ${tenants.length} tenant(s)`,
    );
    return { count: upserted, result: { upserted, tenants: tenants.length } };
  }

  async refitCalibration(onProgress?: RefitProgress): Promise<RefitOutcome> {
    const tenants = this.apiKeys.knownCompanyIds();
    const allPairs: CalibrationPair[] = [];
    for (const companyId of tenants) {
      try {
        const pairs = await this.collectCalibrationPairsForTenant(companyId);
        allPairs.push(...pairs);
        onProgress?.({ currentTenant: companyId, pairsCollected: allPairs.length });
      } catch (e) {
        this.logger.warn(
          `calibration pair collection failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    if (allPairs.length < 40) {
      const msg = `calibration refit skipped — only ${allPairs.length} pair(s) (need 40+)`;
      this.logger.log(msg);
      return {
        count: 0,
        result: {
          skipped: true,
          skipReason: msg,
          pairsCollected: allPairs.length,
          floor: 40,
        },
      };
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
    return {
      count: map.sampleCount,
      result: { sampleCount: map.sampleCount, bins: map.thresholds.length },
    };
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
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      }));
    });
  }

  private async refitSourceTrustForTenant(companyId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            vertical: string | null;
            recorder: string | null;
            status: string;
          }>,
        ]
      >(
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
        Array.isArray(latest) && latest[0]?.version ? latest[0].version + 1 : 2;
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
 * A fact's "correctness" for calibration purposes — see the
 * documented survivorship bias: a never-retracted fact counts as
 * correct (FaithfulRAG weak-supervision recipe).
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
