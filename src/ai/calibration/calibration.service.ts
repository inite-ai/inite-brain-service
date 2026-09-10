import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { envFlagNotDisabled } from '../../common/env-validation';
import { createHash } from 'node:crypto';
import { applyMap, fitIsotonic, type CalibrationMap } from './isotonic';
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
 * DB persistence (calibration_table — migration 0019) is written by the
 * nightly refit (calibration-refit-runner.service.ts), which runs under
 * a lease on ONE replica and installs its fit locally via loadMap. Every
 * replica — that one included — polls the table every
 * CALIBRATION_POLL_MS and swaps in a newer version atomically, so the
 * same raw confidence calibrates identically on every replica within
 * one poll interval of the refit. The synthetic bootstrap is only the
 * cold-start map (arXiv:2502.11028: 66.7% of errors at >0.80 raw).
 */
@Injectable()
export class CalibrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CalibrationService.name);
  private readonly cache = new Map<string, CalibrationMap>();
  private readonly disabled: boolean;
  private readonly extractorModel: string;
  // Mutable so the table poll can replace the synthetic fit with a
  // persisted calibration_table row when one is available.
  private bootstrapMap: CalibrationMap;
  private bootstrapSource: 'synthetic' | 'persisted' = 'synthetic';
  /** calibration_table.version this process runs; 0 = synthetic. */
  private persistedVersion = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly surreal?: SurrealService,
    @Optional() private readonly apiKeys?: ApiKeyService,
  ) {
    this.disabled = !envFlagNotDisabled(this.configService.get<string>('CALIBRATION_USE_GOLD_SET'));
    this.extractorModel = this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
    this.bootstrapMap = fitIsotonic(BOOTSTRAP_GOLD_SET);
    if (!this.disabled) {
      this.logger.log(
        `Calibration bootstrap fitted: model=${this.extractorModel} samples=${this.bootstrapMap.sampleCount} bins=${this.bootstrapMap.thresholds.length} source=${this.bootstrapSource}`,
      );
    }
  }

  /**
   * Load the persisted map once at boot, then keep polling for a newer
   * version. The poll timer is unref'd: it never keeps the process
   * alive, and a tick that finds no newer version installs nothing.
   */
  async onModuleInit(): Promise<void> {
    if (this.disabled || !this.surreal || !this.apiKeys) return;
    await this.refreshFromTable();
    this.pollTimer = setInterval(() => void this.refreshFromTable(), CALIBRATION_POLL_MS);
    this.pollTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /**
   * Install the latest calibration_table row when its version is newer
   * than the one this process runs AND its sampleCount crosses the
   * 40-pair floor the refit also enforces. A persisted row is a strictly
   * better prior than the hand-curated bootstrap, and it is
   * operator-wide: fresh tenants in a multi-tenant deploy inherit it
   * too. Tenants are re-resolved on every tick because the registry
   * fills at runtime. One index-backed read per tick; a failure keeps
   * the current map and is retried next tick.
   */
  async refreshFromTable(): Promise<void> {
    if (this.refreshing || this.disabled || !this.surreal || !this.apiKeys) return;
    const host = this.apiKeys.knownCompanyIds()[0];
    if (!host) return;
    this.refreshing = true;
    try {
      const row = await this.loadPersistedBootstrap(host);
      if (!row || row.version <= this.persistedVersion) return;
      this.installPersisted(row);
      this.logger.log(
        `Calibration map installed from calibration_table: model=${this.extractorModel} version=${row.version} samples=${row.map.sampleCount} bins=${row.map.thresholds.length}`,
      );
    } catch (e) {
      this.logger.warn(
        `Calibration table poll failed (${(e as Error).message}); keeping the ${this.bootstrapSource} map`,
      );
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Atomic swap: one assignment per reference, no intermediate state a
   * concurrent calibrate() could observe. The bootstrap-key cache entry
   * is overwritten as well — loadMap (the refit's same-process fast
   * path) writes there and calibrate() reads it first, so a map this
   * process fitted an earlier night must not shadow a newer persisted
   * one.
   */
  private installPersisted(row: PersistedCalibrationRow): void {
    this.bootstrapMap = row.map;
    this.bootstrapSource = 'persisted';
    this.persistedVersion = row.version;
    this.cache.set(cacheKey(this.extractorModel, BOOTSTRAP_PROMPT_HASH), row.map);
  }

  private async loadPersistedBootstrap(host: string): Promise<PersistedCalibrationRow | null> {
    if (!this.surreal) return null;
    return this.surreal.withCompany(host, async (db) => {
      const [rows] = await db.query<[CalibrationTableRow[]]>(
        `SELECT version, thresholds, values, sampleCount
           FROM calibration_table
           WHERE extractorModel = $m AND promptHash = $p
           ORDER BY version DESC LIMIT 1`,
        { m: this.extractorModel, p: BOOTSTRAP_PROMPT_HASH },
      );
      const row = (rows as CalibrationTableRow[] | undefined)?.[0];
      if (!row || !Array.isArray(row.thresholds) || !Array.isArray(row.values)) {
        return null;
      }
      if (row.sampleCount < 40) return null;
      if (row.thresholds.length !== row.values.length) return null;
      return {
        version: typeof row.version === 'number' ? row.version : 1,
        map: {
          thresholds: row.thresholds,
          values: row.values,
          sampleCount: row.sampleCount,
        },
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
  loadMap(extractorModel: string, promptText: string, map: CalibrationMap): void {
    if (this.disabled) return;
    this.cache.set(cacheKey(extractorModel, promptHashOf(promptText)), map);
  }
}

/** How often every replica re-reads calibration_table for a newer version. */
export const CALIBRATION_POLL_MS = 3 * 60_000;

interface CalibrationTableRow {
  version?: number;
  thresholds: number[];
  values: number[];
  sampleCount: number;
}

interface PersistedCalibrationRow {
  version: number;
  map: CalibrationMap;
}

function cacheKey(extractorModel: string, promptHash: string): string {
  return `${extractorModel}::${promptHash}`;
}

/** Stable hash for cache keys + DB rows. Hex digest of SHA-256. */
export function promptHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Canonical key for the shared "bootstrap" calibration row. MUST be
 * identical on the write side (calibration-refit.service persist) and
 * the read side (this service's boot loader + runtime calibrate()).
 * They diverged once — the refit wrote the literal `'bootstrap'` while
 * the loader queried `promptHashOf('bootstrap')`, so persisted nightly
 * refits were never reloaded after a restart. Both now import this.
 */
export const BOOTSTRAP_PROMPT_KEY = 'bootstrap';
export const BOOTSTRAP_PROMPT_HASH = promptHashOf(BOOTSTRAP_PROMPT_KEY);
