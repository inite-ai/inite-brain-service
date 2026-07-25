import { StringRecordId, type Surreal } from 'surrealdb';
import { cosineSimilarity } from '../../common/vector-math';
import { envFlagEnabled } from '../../common/env-validation';
import type { EntityBucket, FactRow } from './types';

/**
 * Occlusion ranking (SEARCH_OCCLUSION_ENABLED) — front-to-back fact
 * selection over the final top-K buckets, renderer-style: candidates are
 * visited in global score order, and a candidate is OCCLUDED (skipped
 * without consuming a slot) when an already-kept fact covers it —
 * embedding cosine ≥ threshold. The freed per-entity slot is then filled
 * by the next-ranked non-duplicate candidate, so redundancy converts
 * into coverage at an unchanged context size.
 *
 * Two halves, mirroring the identity-merge module layout:
 *   * selectFactsWithOcclusion — the pure selector (no DB, unit-tested).
 *   * resolveOcclusion — flag/knob resolution + the one bounded
 *     embedding fetch (legs deliberately don't project embeddings; this
 *     stage pays a single INSIDE-$ids round-trip only when the flag is
 *     on, and degrades to off on any failure).
 *
 * The kept surface is GLOBAL across entities (a kept fact of hit #1
 * occludes a near-duplicate on hit #3) while slot accounting stays
 * per-entity, so the hit shape and factsPerEntity semantics are
 * untouched. Facts without a fetched embedding neither occlude nor get
 * occluded — safe degradation, counted in stats.
 */

export interface OcclusionCandidate {
  factId: string;
  score: number;
  /** Bitemporal start — date-guard input. */
  validFrom: string;
  /** Backfill predicate-diversity accounting. */
  predicate: string;
}

export interface EntityCandidates {
  entityId: string;
  /** Render-order matched facts: provenance-filtered, score desc. */
  matched: OcclusionCandidate[];
  /** Render-order backfill rows (existing recency/relevance order). */
  backfill: OcclusionCandidate[];
}

export interface OcclusionConfig {
  /** Cosine at or above which a kept fact occludes a candidate. */
  threshold: number;
  /**
   * Temporal-QA ablation guard: occlusion only fires when the two facts'
   * validFrom are within this many days. null = guard disabled (any
   * distance occludes). Unparseable dates block occlusion (visible).
   */
  dateGuardDays: number | null;
  embeddings: ReadonlyMap<string, number[]>;
  factsPerEntity: number;
  backfillPerPredicate: number;
}

export interface OcclusionStats {
  candidates: number;
  kept: number;
  occluded: number;
  /** Kept facts that only rendered because occlusion freed a slot. */
  refilled: number;
  missingEmbedding: number;
}

export interface OcclusionSelection {
  matched: Set<string>;
  /** Kept backfill fact ids, in render order. */
  backfill: string[];
}

/**
 * Knob bundle handed from resolveOcclusion to assembleHits. onStats is
 * assigned by the orchestrator (traceArtifact) so this module stays free
 * of the debug-trace dependency.
 */
export interface OcclusionInputs {
  threshold: number;
  dateGuardDays: number | null;
  embeddings: Map<string, number[]>;
  onStats?: (stats: OcclusionStats) => void;
}

const MS_PER_DAY = 86_400_000;

export function selectFactsWithOcclusion(
  entities: EntityCandidates[],
  cfg: OcclusionConfig,
): { keptByEntity: Map<string, OcclusionSelection>; stats: OcclusionStats } {
  const stats: OcclusionStats = {
    candidates: 0,
    kept: 0,
    occluded: 0,
    refilled: 0,
    missingEmbedding: 0,
  };
  const keptByEntity = new Map<string, OcclusionSelection>();
  const slots = new Map<string, number>();
  for (const e of entities) {
    keptByEntity.set(e.entityId, { matched: new Set(), backfill: [] });
    slots.set(e.entityId, 0);
    stats.candidates += e.matched.length + e.backfill.length;
  }

  // Global kept surface — only facts with embeddings can occlude.
  const keptSurface: Array<{ embedding: number[]; validFromMs: number }> = [];
  const guardMs =
    cfg.dateGuardDays === null ? null : cfg.dateGuardDays * MS_PER_DAY;
  const isOccluded = (embedding: number[], validFromMs: number): boolean => {
    for (const k of keptSurface) {
      if (cosineSimilarity(embedding, k.embedding) < cfg.threshold) continue;
      // NaN deltas (unparseable dates) fail the ≤ and stay visible.
      if (
        guardMs !== null &&
        !(Math.abs(validFromMs - k.validFromMs) <= guardMs)
      ) {
        continue;
      }
      return true;
    }
    return false;
  };

  /**
   * Shared keep-or-skip for one candidate. posInEntity is the candidate's
   * index in its entity's matched⧺backfill render order — at or past the
   * per-entity cap it could only render via a freed slot (refilled).
   */
  const consider = (
    entityId: string,
    cand: OcclusionCandidate,
    posInEntity: number,
  ): 'kept' | 'occluded' | 'skipped' => {
    if ((slots.get(entityId) ?? 0) >= cfg.factsPerEntity) return 'skipped';
    const embedding = cfg.embeddings.get(cand.factId);
    if (!embedding) {
      stats.missingEmbedding++;
    } else if (isOccluded(embedding, Date.parse(cand.validFrom))) {
      stats.occluded++;
      return 'occluded';
    }
    slots.set(entityId, (slots.get(entityId) ?? 0) + 1);
    stats.kept++;
    if (posInEntity >= cfg.factsPerEntity) stats.refilled++;
    if (embedding) {
      keptSurface.push({ embedding, validFromMs: Date.parse(cand.validFrom) });
    }
    return 'kept';
  };

  // Phase 1 — matched, front-to-back globally. The flatten order is
  // (entity rank, per-entity score order); the stable sort keeps that
  // order for equal scores, so ties resolve toward the higher-ranked hit.
  const flat: Array<{
    entityId: string;
    cand: OcclusionCandidate;
    pos: number;
  }> = [];
  for (const e of entities) {
    e.matched.forEach((cand, pos) =>
      flat.push({ entityId: e.entityId, cand, pos }),
    );
  }
  flat.sort((a, b) => b.cand.score - a.cand.score);
  for (const { entityId, cand, pos } of flat) {
    if (consider(entityId, cand, pos) === 'kept') {
      keptByEntity.get(entityId)!.matched.add(cand.factId);
    }
  }

  // Phase 2 — backfill, per entity in rank order. Predicate budget is
  // seeded from KEPT matched facts only (an occluded matched fact must
  // not block a substitute of the same predicate), and an occluded
  // backfill row consumes neither a slot nor predicate budget.
  for (const e of entities) {
    const selection = keptByEntity.get(e.entityId)!;
    const predicateCount = new Map<string, number>();
    for (const cand of e.matched) {
      if (!selection.matched.has(cand.factId)) continue;
      predicateCount.set(
        cand.predicate,
        (predicateCount.get(cand.predicate) ?? 0) + 1,
      );
    }
    e.backfill.forEach((cand, i) => {
      if ((slots.get(e.entityId) ?? 0) >= cfg.factsPerEntity) return;
      const used = predicateCount.get(cand.predicate) ?? 0;
      if (used >= cfg.backfillPerPredicate) return;
      if (consider(e.entityId, cand, e.matched.length + i) === 'kept') {
        predicateCount.set(cand.predicate, used + 1);
        selection.backfill.push(cand.factId);
      }
    });
  }

  return { keptByEntity, stats };
}

/** Cosine threshold with a (0,1] clamp; out-of-range → default. */
function thresholdEnv(): number {
  const v = parseFloat(process.env.SEARCH_OCCLUSION_THRESHOLD ?? '');
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
}

/** Per-entity candidate rows considered for the embedding fetch. */
function windowEnv(): number {
  const v = parseInt(process.env.SEARCH_OCCLUSION_WINDOW ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 24;
}

/** Date guard in days; unset/0/invalid → null (disabled). */
function dateGuardEnv(): number | null {
  const v = parseInt(process.env.SEARCH_OCCLUSION_DATE_GUARD_DAYS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Flag/knob resolution + the single bounded embedding fetch. Returns
 * null when the flag is off (zero cost — flag read per request, so the
 * knob is runtime-mutable) or when the fetch fails (warn + degrade to
 * off, the backfill soft-fail idiom). Embeddings live only in the
 * returned request-local Map — they are never attached to FactRow, so
 * they cannot reach the wire.
 */
export async function resolveOcclusion(opts: {
  db: Surreal;
  logger: { warn(message: string): void };
  topEntities: EntityBucket[];
  backfillByEntity: Map<string, FactRow[]>;
  factsPerEntity: number;
}): Promise<OcclusionInputs | null> {
  if (!envFlagEnabled(process.env.SEARCH_OCCLUSION_ENABLED)) return null;
  const window = Math.max(windowEnv(), opts.factsPerEntity);
  const ids = new Set<string>();
  for (const bucket of opts.topEntities) {
    const byScore = [...bucket.facts].sort((a, b) => b.score - a.score);
    for (const sf of byScore.slice(0, window)) ids.add(String(sf.row.id));
    const backfill = opts.backfillByEntity.get(bucket.entityId) ?? [];
    for (const row of backfill.slice(0, window)) ids.add(String(row.id));
  }
  const inputs: OcclusionInputs = {
    threshold: thresholdEnv(),
    dateGuardDays: dateGuardEnv(),
    embeddings: new Map(),
  };
  if (ids.size === 0) return inputs;
  try {
    const [rows] = await opts.db.query<
      [Array<{ id: unknown; embedding: unknown }>]
    >(
      `SELECT id, embedding FROM knowledge_fact
        WHERE id INSIDE $ids AND embedding IS NOT NONE`,
      { ids: [...ids].map((s) => new StringRecordId(s)) },
    );
    for (const r of rows ?? []) {
      if (Array.isArray(r.embedding) && r.embedding.length > 0) {
        inputs.embeddings.set(String(r.id), r.embedding as number[]);
      }
    }
    return inputs;
  } catch (e) {
    opts.logger.warn(
      `occlusion embedding fetch failed: ${(e as Error).message}`,
    );
    return null;
  }
}
