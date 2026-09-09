import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { lensSuppressEnabled, lensSuppressMinCosine } from '../common/fovea-flags';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { describeSpaceIncompatibility } from '../ai/embedder/embedding-space';
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
  /**
   * The embedding space the centroid was mined in
   * (`provider:model:dim:norm`). REQUIRED, and it must be the tenant's
   * primary space — the only space a centroid may be stored in. A width
   * check alone cannot tell two models of the same width apart, and a
   * centroid from the wrong model at the right width is silently wrong
   * forever (there is no source text to re-embed it from); requiring the
   * declaration makes the operator assert something checkable. Absent or
   * incompatible is a 400.
   */
  embeddingSpaceId: string;
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
            embeddingSpaceId?: string | null;
          }>,
        ]
      >(
        `SELECT classId, centroid, suppressLanes, sampleCount, version, embeddingSpaceId
            FROM lens_suppression
            ORDER BY version DESC`,
      );
      const byClass = new Map<string, LensSuppressionClass>();
      for (const r of rows ?? []) {
        // First row per class wins (rows are version-desc ordered).
        if (byClass.has(r.classId)) continue;
        if (!Array.isArray(r.centroid) || !Array.isArray(r.suppressLanes)) continue;
        // Never cosine a centroid the corpus cannot be compared against: a
        // row written before the write guard (0132) at a foreign width, or
        // one left behind by an embedder re-configuration, would raise for
        // the whole query. Skip it, say so (once an hour per class), and let
        // the governor stay static for that class — the byte-identical
        // fallback.
        const unusable = this.centroidUnusableReason(r);
        if (unusable !== null) {
          this.noteUnusableCentroid(companyId, r.classId, unusable);
          continue;
        }
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
   * Why a stored centroid must not be served, or null when it may. The
   * width is compared against the PRIMARY space (the corpus it will be
   * compared with); a stamped space must be compatible with it. An
   * unstamped row at the right width predates 0132 and is accepted — the
   * stamp is what makes a same-width foreign model detectable, so it is
   * required on every NEW write (assertCentroidSpace) but cannot be
   * demanded of history.
   */
  private centroidUnusableReason(r: {
    centroid: number[];
    embeddingSpaceId?: string | null;
  }): string | null {
    if (!this.embedder) return null;
    const expected = this.embedder.primaryDimensions();
    const primary = this.embedder.primarySpaceId();
    if (r.centroid.length !== expected) {
      return `${r.centroid.length}-wide centroid, corpus is ${expected}-wide (${primary})`;
    }
    if (typeof r.embeddingSpaceId === 'string' && r.embeddingSpaceId !== '') {
      const reason = describeSpaceIncompatibility(r.embeddingSpaceId, primary);
      if (reason !== null) {
        return `stamped '${r.embeddingSpaceId}', corpus is '${primary}' (${reason})`;
      }
    }
    return null;
  }

  /** Once an hour per (tenant, class) — loadModel runs per query. */
  private readonly unusableWarnedAt = new Map<string, number>();

  private noteUnusableCentroid(companyId: string, classId: string, reason: string): void {
    const key = `${companyId}::${classId}`;
    const now = Date.now();
    if (now - (this.unusableWarnedAt.get(key) ?? 0) < 60 * 60_000) return;
    this.unusableWarnedAt.set(key, now);
    this.logger.warn(
      `lens-suppression: skipping class '${classId}' for ${companyId} — ${reason}. ` +
        `The governor stays static for it; re-fit the class offline in the tenant's space.`,
    );
  }

  /**
   * The write guard #503 could not reach.
   *
   * `lens_suppression.centroid` is the one vector in the system that never
   * touches the embedder: the training data is offline ablation-mined, so
   * the operator POSTs the centroid. EmbedderService's guard is a guard on
   * the embedder — it fails closed when the serving provider is in a
   * foreign space and re-checks the produced width — and a vector produced
   * elsewhere simply walks past it. Until this, the only validation was
   * that the numbers are finite.
   *
   * The invariant is the same one #503 argued and the reason is the same:
   * a cross-space READ is transient and self-healing, a cross-space WRITE
   * is durable damage. A 1536-wide centroid in a 1024-wide tenant makes
   * `vector::similarity::cosine` raise for the whole query the moment the
   * governor is switched on, and it cannot be repaired by re-embedding —
   * there is no stored source text for it (it arrives from outside), so
   * the only fix is to re-fit the model offline.
   *
   * Validated against the PRIMARY space, never the serving one: the
   * centroid did not come from whoever happens to be serving, and the
   * corpus it will be compared against is the primary's. That also keeps
   * the ingest usable during the bge-m3 warmup window instead of 503-ing
   * for no reason.
   *
   * Unconditional, not flag-gated — exactly as #503's guard is. There is no
   * configuration in which persisting a wrong-width centroid is the desired
   * outcome, and the whole surface is already behind FOVEA_LENS_SUPPRESS
   * (the routes 404 when it is off).
   */
  private assertCentroidSpace(c: LensSuppressionFitClass): string {
    if (!this.embedder) {
      // Width unknowable ⇒ refuse. Fail closed: an unvalidated centroid is
      // durable and unrepairable, a 503 is retryable.
      throw new ServiceUnavailableException(
        `lens-suppression fit: no embedder is wired, so the centroid width for ` +
          `class '${c.classId}' cannot be validated. Refusing to persist an ` +
          `unvalidated vector.`,
      );
    }
    const expected = this.embedder.primaryDimensions();
    if (c.centroid.length !== expected) {
      throw new BadRequestException(
        `lens-suppression fit: class '${c.classId}' has a ${c.centroid.length}-wide ` +
          `centroid but this tenant's corpus is ${expected}-wide ` +
          `(${this.embedder.primarySpaceId()}). A cross-space centroid is ` +
          `cosine-compared against query vectors and is meaningless.`,
      );
    }
    const primary = this.embedder.primarySpaceId();
    if (typeof c.embeddingSpaceId !== 'string' || c.embeddingSpaceId.trim() === '') {
      // Width alone cannot tell two models of the same width apart, and a
      // wrong-model centroid at the right width is durable and silent.
      throw new BadRequestException(
        `lens-suppression fit: class '${c.classId}' must declare embeddingSpaceId — the space ` +
          `the centroid was mined in; this tenant's is '${primary}'.`,
      );
    }
    const reason = describeSpaceIncompatibility(c.embeddingSpaceId, primary);
    if (reason !== null) {
      throw new BadRequestException(
        `lens-suppression fit: class '${c.classId}' declares embedding space ` +
          `'${c.embeddingSpaceId}' but this tenant serves '${primary}' (${reason}).`,
      );
    }
    // Stamp the space that was actually validated, so a later width change
    // can tell an old centroid from a current one (0101/0132).
    return primary;
  }

  /**
   * THIN INGEST of externally-mined suppression rows (the training data is
   * offline/parked). Each class is persisted as a NEW versioned row
   * (calibration_table idiom); the reader picks max(version) per class.
   * Unknown lane ids are dropped. Returns the persisted class ids.
   *
   * Every class is width- and space-checked BEFORE anything is written, so
   * a batch with one bad centroid persists nothing rather than half of
   * itself.
   */
  async fitAndPersist(
    companyId: string,
    classes: readonly LensSuppressionFitClass[],
  ): Promise<{ persisted: number; classes: string[] }> {
    const spaces = classes.map((c) => this.assertCentroidSpace(c));
    return this.surreal.withCompany(companyId, async (db) => {
      const out: string[] = [];
      for (const [i, c] of classes.entries()) {
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
              version: $version,
              embeddingSpaceId: $embeddingSpaceId
           }`,
          {
            companyId,
            classId: c.classId,
            centroid: c.centroid,
            suppressLanes,
            sampleCount: c.sampleCount,
            version: next,
            embeddingSpaceId: spaces[i],
          },
        );
        out.push(c.classId);
      }
      return { persisted: out.length, classes: out };
    });
  }

  /** List the latest suppression class per classId (max version) — the admin
   *  read surface. Centroid vectors are omitted (bulky, not operator-useful);
   *  the width and the space stamp are exactly what an operator checking a
   *  fit needs, so both are reported (0132). A NONE stamp is a row written
   *  before the guard existed and reads as the legacy/implicit space. */
  async listClasses(companyId: string): Promise<
    Array<{
      classId: string;
      suppressLanes: string[];
      sampleCount: number;
      version: number;
      centroidDim: number;
      embeddingSpaceId: string | null;
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
            embeddingSpaceId?: string | null;
          }>,
        ]
      >(
        `SELECT classId, centroid, suppressLanes, sampleCount, version, embeddingSpaceId
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
        embeddingSpaceId: string | null;
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
          embeddingSpaceId: typeof r.embeddingSpaceId === 'string' ? r.embeddingSpaceId : null,
        });
      }
      return out;
    });
  }
}
