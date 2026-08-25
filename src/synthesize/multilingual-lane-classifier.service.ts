import { Injectable, Logger, Optional } from '@nestjs/common';
import { EmbedderService } from '../ai/embedder.service';
import type { LaneId } from '../search/retrieval-profile';
import {
  buildLaneCentroids,
  classifyLane,
  CLASSIFIER_LANES,
  LANE_CLASSIFIER_MIN_COSINE,
  LANE_CLASSIFIER_MIN_MARGIN,
  LANE_EXEMPLARS,
  type ClassifierLane,
  type LaneClassifierModel,
} from './multilingual-lane-classifier';

/**
 * MultilingualLaneClassifierService — the embedder + cache shell around the
 * pure lane classifier (multilingual-lane-classifier.ts). Mirrors the
 * lens-suppression service split: the DECISION is pure; the service owns only
 * the embedder call and the centroid cache.
 *
 * Nothing here reads env: the master flag is resolved into the profile
 * (RetrievalProfile.multilingualLaneRouting) at the retrieval-profile
 * boundary and checked by the caller (SynthesizeService) BEFORE this service
 * is invoked, keeping the synthesize dir env-free (engine-gates S5.2). The
 * embedder is @Optional so positionally-constructed unit tests stay as-is;
 * absent embedder ⇒ augmentLane returns null (byte-identical to the unrouted
 * generic path).
 */
@Injectable()
export class MultilingualLaneClassifierService {
  private readonly logger = new Logger(MultilingualLaneClassifierService.name);

  /** Centroids are keyed by embedding dimension so a provider swap that
   *  changes the space rebuilds instead of cosine-comparing across spaces. */
  private cached: { key: string; model: LaneClassifierModel } | undefined;
  private building: Promise<LaneClassifierModel> | undefined;

  constructor(@Optional() private readonly embedder?: EmbedderService) {}

  /**
   * Propose a routable lane for a query the regex router missed, or null.
   * Any failure (embedder absent, embed error, empty model, abstain) resolves
   * to null so the caller keeps the generic path — byte-identical to today.
   */
  async augmentLane(query: string, activeLanes: ReadonlySet<LaneId>): Promise<LaneId | null> {
    if (!this.embedder || !query.trim()) return null;
    try {
      const model = await this.centroids();
      if (model.length === 0) return null;
      const queryEmbedding = await this.embedder.embed(query);
      const decision = classifyLane({
        model,
        queryEmbedding,
        activeLanes,
        minCosine: LANE_CLASSIFIER_MIN_COSINE,
        minMargin: LANE_CLASSIFIER_MIN_MARGIN,
      });
      if (decision.lane) {
        this.logger.debug(
          `multilingual lane classifier: routed=${decision.lane} ` +
            `cos=${decision.ranked[0]?.cosine.toFixed(3)}`,
        );
      }
      return decision.lane;
    } catch (e) {
      this.logger.warn(
        `multilingual lane classifier failed; generic path: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /** Build (once) + cache the per-lane centroids from the embedded exemplar
   *  set. Concurrent first calls share one in-flight build. */
  private async centroids(): Promise<LaneClassifierModel> {
    const key = String(this.embedder!.getDimensions());
    if (this.cached?.key === key) return this.cached.model;
    if (this.building) return this.building;
    this.building = this.buildCentroids(key);
    try {
      return await this.building;
    } finally {
      this.building = undefined;
    }
  }

  private async buildCentroids(key: string): Promise<LaneClassifierModel> {
    const byLane = new Map<ClassifierLane, number[][]>();
    for (const lane of CLASSIFIER_LANES) {
      byLane.set(lane, await this.embedder!.embedMany([...LANE_EXEMPLARS[lane]]));
    }
    const model = buildLaneCentroids(byLane);
    this.cached = { key, model };
    return model;
  }
}
