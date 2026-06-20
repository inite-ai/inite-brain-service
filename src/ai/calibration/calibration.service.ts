import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  applyMap,
  fitIsotonic,
  type CalibrationMap,
} from './isotonic';
import { BOOTSTRAP_GOLD_SET } from './gold-set';
import { SurrealService } from '../../db/surreal.service';
import { ApiKeyService } from '../../auth/api-key.service';

/**
 * CalibrationService — owns the (extractorModel, promptHash) →
 * CalibrationMap lookup. Phase 3 design:
 *
 *   - On boot, fits a map from the in-process BOOTSTRAP_GOLD_SET and
 *     caches it under the active extractor model. The cache is
 *     in-process; per-worker variance is acceptable because every
 *     worker fits from the same deterministic gold set.
 *   - At runtime, `calibrate(rawConfidence, model, prompt)` returns
 *     the calibrated value using the cached map.
 *   - When `CALIBRATION_USE_GOLD_SET=0` is set, the service returns
 *     the raw confidence unchanged — used for tests + paths where the
 *     extractor's value already passed an upstream confidence gate.
 *
 * DB persistence (calibration_table — migration 0019) is reserved for
 * Phase 3.5 nightly recalculation. The schema is already in place;
 * the nightly job will write versioned rows that this service will
 * hot-reload via polling. For Phase 3.A we ship with the synthetic
 * bootstrap only — sufficient to fix the systematic overconfidence
 * documented in arXiv:2502.11028 (66.7% of errors at >0.80 raw).
 */
@Injectable()
export class CalibrationService implements OnModuleInit {
  private readonly logger = new Logger(CalibrationService.name);
  private readonly cache = new Map<string, CalibrationMap>();
  private readonly disabled: boolean;
  private readonly extractorModel: string;
  // Mutable so onModuleInit can replace the synthetic fit with a
  // persisted calibration_table row when one is available.
  private bootstrapMap: CalibrationMap;
  private bootstrapSource: 'synthetic' | 'persisted' = 'synthetic';

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly surreal?: SurrealService,
    @Optional() private readonly apiKeys?: ApiKeyService,
  ) {
    this.disabled =
      this.configService.get<string>('CALIBRATION_USE_GOLD_SET', '1') === '0';
    this.extractorModel = this.configService.get<string>(
      'OPENAI_CHAT_MODEL',
      'gpt-4o-mini',
    );
    this.bootstrapMap = fitIsotonic(BOOTSTRAP_GOLD_SET);
    if (!this.disabled) {
      this.logger.log(
        `Calibration bootstrap fitted: model=${this.extractorModel} samples=${this.bootstrapMap.sampleCount} bins=${this.bootstrapMap.thresholds.length} source=${this.bootstrapSource}`,
      );
    }
  }

  /**
   * Replace the synthetic bootstrap with the latest persisted
   * calibration_table row when one is available AND its sampleCount
   * crosses the 40-pair floor that the refit-service also enforces.
   *
   * Why: the synthetic gold set was a fixture for the cold-start case.
   * Once the nightly refit (calibration-refit.service.ts) has run at
   * least once on real data, that persisted row is a strictly better
   * prior than the hand-curated bootstrap. Lifting it on boot also
   * eliminates the audit's "tenants <40 pairs stay on synthetic
   * forever" failure mode — even fresh tenants in a multi-tenant
   * deploy inherit the operator-wide calibration immediately.
   */
  async onModuleInit(): Promise<void> {
    if (this.disabled || !this.surreal || !this.apiKeys) return;
    const tenants = this.apiKeys.knownCompanyIds();
    if (tenants.length === 0) return;
    const host = tenants[0];
    try {
      const map = await this.loadPersistedBootstrap(host);
      if (map) {
        this.bootstrapMap = map;
        this.bootstrapSource = 'persisted';
        this.logger.log(
          `Calibration bootstrap replaced from calibration_table: model=${this.extractorModel} samples=${map.sampleCount} bins=${map.thresholds.length}`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Calibration persisted-bootstrap probe failed (${(e as Error).message}); ` +
          `staying on synthetic gold set`,
      );
    }
  }

  private async loadPersistedBootstrap(
    host: string,
  ): Promise<CalibrationMap | null> {
    if (!this.surreal) return null;
    return this.surreal.withCompany(host, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            thresholds: number[];
            values: number[];
            sampleCount: number;
          }>,
        ]
      >(
        `SELECT thresholds, values, sampleCount
           FROM calibration_table
           WHERE extractorModel = $m AND promptHash = $p
           ORDER BY version DESC LIMIT 1`,
        { m: this.extractorModel, p: promptHashOf('bootstrap') },
      );
      const row = (rows as Array<{
        thresholds: number[];
        values: number[];
        sampleCount: number;
      }>)?.[0];
      if (!row || !Array.isArray(row.thresholds) || !Array.isArray(row.values)) {
        return null;
      }
      if (row.sampleCount < 40) return null;
      if (row.thresholds.length !== row.values.length) return null;
      return {
        thresholds: row.thresholds,
        values: row.values,
        sampleCount: row.sampleCount,
      };
    });
  }

  /**
   * Source of the currently-active bootstrap map. Exposed primarily for
   * the metrics dashboard / debug endpoints — a tenant freshly onboarded
   * after the nightly refit should see `'persisted'`.
   */
  getBootstrapSource(): 'synthetic' | 'persisted' {
    return this.bootstrapSource;
  }

  /**
   * Apply the active calibration map for (extractorModel, promptHash)
   * to a raw confidence. Falls back to identity when the service is
   * disabled. The promptText is hashed and used as part of the cache
   * key so per-prompt nightly fits coexist; for the bootstrap we use
   * a single shared map keyed on the model alone.
   */
  calibrate(
    rawConfidence: number,
    extractorModel: string = this.extractorModel,
    promptText = 'bootstrap',
  ): number {
    if (this.disabled) return rawConfidence;
    const key = cacheKey(extractorModel, promptHashOf(promptText));
    const map = this.cache.get(key) ?? this.bootstrapMap;
    return applyMap(map, rawConfidence);
  }

  /**
   * Expose the active map for inspection (e.g. debug endpoints).
   * Returns the bootstrap when no per-(model, prompt) override was
   * loaded. Returns null only when the service is disabled.
   */
  getMap(
    extractorModel: string = this.extractorModel,
    promptText = 'bootstrap',
  ): CalibrationMap | null {
    if (this.disabled) return null;
    const key = cacheKey(extractorModel, promptHashOf(promptText));
    return this.cache.get(key) ?? this.bootstrapMap;
  }

  /**
   * Load an override map fitted offline (e.g. by the Phase 3.5 nightly
   * job consuming the CHANGEFEED). The next `calibrate()` for that
   * (model, prompt) pair uses the new map.
   */
  loadMap(
    extractorModel: string,
    promptText: string,
    map: CalibrationMap,
  ): void {
    if (this.disabled) return;
    this.cache.set(cacheKey(extractorModel, promptHashOf(promptText)), map);
  }
}

function cacheKey(extractorModel: string, promptHash: string): string {
  return `${extractorModel}::${promptHash}`;
}

/** Stable hash for cache keys + DB rows. Hex digest of SHA-256. */
function promptHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
