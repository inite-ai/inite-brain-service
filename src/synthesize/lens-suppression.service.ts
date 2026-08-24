import { Injectable, Logger, Optional } from '@nestjs/common';
import { lensSuppressEnabled, lensSuppressMinCosine } from '../common/fovea-flags';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { MetricsService } from '../metrics/metrics.service';
import type { RetrievalProfile } from '../search/retrieval-profile';
import {
  decideSuppression,
  isUsableModel,
  toLaneId,
  type LensSuppressionClass,
  type LensSuppressionModel,
} from './lens-suppression';

/** One class row as accepted by the admin `fit` ingest. */
export interface LensSuppressionFitClass {
  classId: string;
  centroid: number[];
  suppressLanes: string[];
  sampleCount: number;
}

/**
 * LensSuppressionService — load + fit + list for the fovea lens-suppression
 * governor (Optics §4.3). Companion to docs/roadmap/fovea-optics-2026-08.md.
 *
 * The DECISION is pure (lens-suppression.ts, decideSuppression); this service
 * owns only persistence and the runtime-flag statics. Persistence follows the
 * focus_calibration versioning idiom (versioned rows per class, max(version)
 * wins, withCompany scope) — it is not a parallel mechanism.
 *
 * The training data is OFFLINE ablation-mined and PARKED, so `fitAndPersist`
 * is a THIN INGEST of externally-provided (class, centroid, suppressLanes)
 * rows, not a serving-time learner. Nothing here reads env directly: the flag
 * statics delegate to the common layer (fovea-flags.ts) so the engine dir
 * stays env-free (engine-gates S5.2).
 */
@Injectable()
export class LensSuppressionService {
  private readonly logger = new Logger(LensSuppressionService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly embedder?: EmbedderService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * The governor's serving entry point (Optics §4.3). Returns the EFFECTIVE
   * profile: the original with off-task / trap-inducing lanes SUBTRACTED for
   * this query's learned class. Subtractive only — it can never add a lane or
   * reorder (the decision is set-minus, see decideSuppression).
   *
   * Load-bearing safety property: flag off, embedder absent, no usable model,
   * a low-confidence class match, or ANY failure → the SAME `profile` object
   * returned unchanged (`effectiveProfile === profile`), so routing AND the
   * answer-cache key are byte-identical to today. A fresh object (with a
   * strict-subset lane set) is returned only when a confident class match
   * actually removed a lane. Env reads live in the common layer (the flag
   * statics), never a direct env read here (engine-gates S5.2). The embed
   * reuses the CACHED EmbedderService — the retrieval pipeline embeds the same
   * query, so this is a cache hit (or one cheap call).
   */
  async effectiveProfile(
    companyId: string,
    profile: RetrievalProfile,
    dto: { query: string },
  ): Promise<RetrievalProfile> {
    if (!this.embedder || !LensSuppressionService.suppressEnabled()) return profile;
    try {
      const model = await this.loadModel(companyId);
      if (!isUsableModel(model)) {
        this.metrics?.countLensSuppression('no_model');
        return profile;
      }
      const queryEmbedding = await this.embedder.embed(dto.query);
      const decision = decideSuppression({
        model,
        queryEmbedding,
        activeLanes: profile.lanes,
        minCosine: LensSuppressionService.minCosine(),
      });
      this.metrics?.countLensSuppression(decision.outcome);
      if (decision.outcome !== 'suppressed') return profile;
      this.logger.debug(
        `lens suppression: class=${decision.classId} cos=${decision.cosine?.toFixed(3)} removed=[${decision.removed.join(',')}]`,
      );
      return { ...profile, lanes: decision.effectiveLanes };
    } catch (e) {
      this.logger.warn(`lens suppression failed; static lane routing: ${(e as Error).message}`);
      return profile;
    }
  }

  /** Master flag — delegates to the common-layer reader (engine dirs take no
   *  direct env reads; see fovea-flags.ts / engine-gates S5.2). Read at call
   *  time so the knob is runtime-mutable. Off ⇒ static lane routing. */
  static suppressEnabled(): boolean {
    return lensSuppressEnabled();
  }

  /** Optics §4.3 nearest-centroid cosine floor — the common-layer reader
   *  (default 0.5). Below it a class match is uncertain and lanes are kept. */
  static minCosine(): number {
    return lensSuppressMinCosine();
  }

  /**
   * Load the latest persisted per-class suppression model for a tenant
   * (max version per class). Unknown/malformed suppress-lane ids are dropped
   * at read time (toLaneId) so a stale entry can never introduce a routing
   * ADD. Returns [] when nothing is persisted → the governor stays static.
   */
  async loadModel(companyId: string): Promise<LensSuppressionModel> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            classId: string;
            centroid: number[];
            suppressLanes: string[];
            sampleCount: number;
            version: number;
          }>,
        ]
      >(
        `SELECT classId, centroid, suppressLanes, sampleCount, version
            FROM lens_suppression
            ORDER BY version DESC`,
      );
      const byClass = new Map<string, LensSuppressionClass>();
      for (const r of rows ?? []) {
        // First row per class wins (rows are version-desc ordered).
        if (byClass.has(r.classId)) continue;
        if (!Array.isArray(r.centroid) || !Array.isArray(r.suppressLanes)) continue;
        const suppressLanes = r.suppressLanes
          .map(toLaneId)
          .filter((l): l is NonNullable<typeof l> => l !== null);
        byClass.set(r.classId, {
          classId: r.classId,
          centroid: r.centroid,
          suppressLanes,
          sampleCount: typeof r.sampleCount === 'number' ? r.sampleCount : 0,
        });
      }
      return [...byClass.values()];
    });
  }

  /**
   * THIN INGEST of externally-mined suppression rows (the training data is
   * offline/parked). Each class is persisted as a NEW versioned row
   * (calibration_table idiom); the reader picks max(version) per class.
   * Unknown lane ids are dropped. Returns the persisted class ids.
   */
  async fitAndPersist(
    companyId: string,
    classes: readonly LensSuppressionFitClass[],
  ): Promise<{ persisted: number; classes: string[] }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const out: string[] = [];
      for (const c of classes) {
        const suppressLanes = c.suppressLanes
          .map(toLaneId)
          .filter((l): l is NonNullable<typeof l> => l !== null);
        const [latest] = await db.query<[Array<{ version: number }>]>(
          `SELECT version FROM lens_suppression
              WHERE classId = $classId ORDER BY version DESC LIMIT 1`,
          { classId: c.classId },
        );
        const next = Array.isArray(latest) && latest[0]?.version ? latest[0].version + 1 : 1;
        await db.query(
          `CREATE lens_suppression CONTENT {
              companyId: $companyId,
              classId: $classId,
              centroid: $centroid,
              suppressLanes: $suppressLanes,
              sampleCount: $sampleCount,
              version: $version
           }`,
          {
            companyId,
            classId: c.classId,
            centroid: c.centroid,
            suppressLanes,
            sampleCount: c.sampleCount,
            version: next,
          },
        );
        out.push(c.classId);
      }
      return { persisted: out.length, classes: out };
    });
  }

  /** List the latest suppression class per classId (max version) — the admin
   *  read surface. Centroid vectors are omitted (bulky, not operator-useful). */
  async listClasses(companyId: string): Promise<
    Array<{
      classId: string;
      suppressLanes: string[];
      sampleCount: number;
      version: number;
      centroidDim: number;
    }>
  > {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            classId: string;
            centroid: number[];
            suppressLanes: string[];
            sampleCount: number;
            version: number;
          }>,
        ]
      >(
        `SELECT classId, centroid, suppressLanes, sampleCount, version
            FROM lens_suppression
            ORDER BY version DESC`,
      );
      const seen = new Set<string>();
      const out: Array<{
        classId: string;
        suppressLanes: string[];
        sampleCount: number;
        version: number;
        centroidDim: number;
      }> = [];
      for (const r of rows ?? []) {
        if (seen.has(r.classId)) continue;
        seen.add(r.classId);
        out.push({
          classId: r.classId,
          suppressLanes: Array.isArray(r.suppressLanes)
            ? r.suppressLanes.map(toLaneId).filter((l): l is NonNullable<typeof l> => l !== null)
            : [],
          sampleCount: typeof r.sampleCount === 'number' ? r.sampleCount : 0,
          version: r.version,
          centroidDim: Array.isArray(r.centroid) ? r.centroid.length : 0,
        });
      }
      return out;
    });
  }
}
