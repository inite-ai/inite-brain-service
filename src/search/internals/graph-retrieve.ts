/**
 * Graph-first retrieval — resolve named entities, walk their 1-hop
 * neighbourhood over knowledge_edge, return facts across (seeds ∪
 * neighbours) optionally filtered by predicate hints.
 *
 * The bug this module fixes: prior `graphSearch` filtered facts of the
 * SEED entity by `predicate IN $hints`. A question like "who runs
 * engineering at Acme" extracts subj=Acme, slot=status — but Acme has
 * no status fact; the status fact lives on Maria (linked to Acme via
 * a works_at edge). The old filter returned zero, falling through to
 * vector which couldn't bridge the semantic gap either.
 *
 * The fix: expand the candidate set to {seeds ∪ 1-hop neighbours}
 * BEFORE applying the hint filter. Maria, as a neighbour of Acme,
 * surfaces with her status fact and the question is answered without
 * leaving the graph.
 *
 * Split into pure assembly (this file) + DB orchestrator (SearchService)
 * so the assembly logic is fully unit-testable without spinning up
 * SurrealDB.
 */

export interface GraphEntity {
  entityId: string;
  type: string;
  canonicalName: string;
  externalRefs?: Record<string, string>;
}

export interface GraphFactRow {
  factId: string;
  entityId: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  status: string;
  recordedAt?: string;
}

import type { ScoreBreakdown } from './types';

export interface GraphRetrieveHit {
  entityId: string;
  entityType: string;
  canonicalName: string;
  externalRefs: Record<string, string>;
  facts: Array<{
    factId: string;
    predicate: string;
    object: string;
    confidence: number;
    validFrom: string;
    validUntil?: string;
    status: string;
    score: number;
    breakdown?: ScoreBreakdown;
  }>;
  score: number;
}

const SEED_SCORE = 1;
const NEIGHBOUR_SCORE = 0.7;
const HINT_MATCH_FACT_SCORE = 1;
const NON_HINT_FACT_SCORE = 0.5;

/**
 * Pure assembly: render the SearchHit-shaped response from resolved
 * entities + fact-by-entity map.
 *
 * Ordering invariants:
 *   1. Seeds (entities the user named) come first, in input order, even
 *      if they have zero facts after dedup — the UI needs the anchor.
 *   2. Neighbours that have at least one hint-matching fact follow.
 *      Without hints, neighbours with ANY fact follow.
 *   3. Neighbours with no relevant facts are dropped — surfacing them
 *      would dilute the answer.
 *
 * Score policy (subject for downstream tuning):
 *   - Seeds: 1.0  (the user named them)
 *   - Neighbours: 0.7  (one edge away)
 *   - Fact-level score: 1.0 if predicate ∈ hints (or no hints), else 0.5
 */
export interface AssembleGraphHitsOptions {
  seedIds: string[];
  entitiesById: Map<string, GraphEntity>;
  factsByEntity: Map<string, GraphFactRow[]>;
  predicateHints: string[];
}

export function assembleGraphHits({
  seedIds,
  entitiesById,
  factsByEntity,
  predicateHints,
}: AssembleGraphHitsOptions): GraphRetrieveHit[] {
  const seedSet = new Set(seedIds);
  const hintSet = new Set(predicateHints);

  const results: GraphRetrieveHit[] = [];

  for (const seedId of seedIds) {
    const ent = entitiesById.get(seedId);
    if (!ent) continue;
    results.push(
      renderHit({
        ent,
        rows: factsByEntity.get(seedId) ?? [],
        hintSet,
        entityScore: SEED_SCORE,
      }),
    );
  }

  for (const [eid, ent] of entitiesById) {
    if (seedSet.has(eid)) continue;
    const rows = factsByEntity.get(eid) ?? [];
    if (rows.length === 0) continue;
    if (hintSet.size > 0 && !rows.some((f) => hintSet.has(f.predicate))) {
      // Neighbour exists but carries no hint-matching fact — dropping
      // keeps the result focused on the asked predicate.
      continue;
    }
    results.push(
      renderHit({ ent, rows, hintSet, entityScore: NEIGHBOUR_SCORE }),
    );
  }

  return results;
}

function renderHit({
  ent,
  rows,
  hintSet,
  entityScore,
}: {
  ent: GraphEntity;
  rows: GraphFactRow[];
  hintSet: Set<string>;
  entityScore: number;
}): GraphRetrieveHit {
  const deduped = dedupeAndSortFacts(rows);
  const stage = entityScore === SEED_SCORE ? 'graph_seed' : 'graph_neighbour';
  return {
    entityId: ent.entityId,
    canonicalName: ent.canonicalName,
    entityType: ent.type,
    externalRefs: ent.externalRefs ?? {},
    score: entityScore,
    facts: deduped.map((f) => {
      const factScore =
        hintSet.size === 0 || hintSet.has(f.predicate)
          ? HINT_MATCH_FACT_SCORE
          : NON_HINT_FACT_SCORE;
      return {
        factId: f.factId,
        predicate: f.predicate,
        object: f.object,
        confidence: f.confidence,
        validFrom: f.validFrom,
        validUntil: f.validUntil,
        status: f.status,
        score: factScore,
        breakdown: {
          fusedScore: factScore,
          confidence: f.confidence,
          decay: 1,
          predBoost: 1,
          finalScore: factScore * f.confidence,
          stages: [stage],
        },
      };
    }),
  };
}

/**
 * Collapse identical-shape active facts (same predicate+object) on a
 * single entity. Fact-level dedup is a runtime concern of dreams.dedup
 * but the demo can't wait for the sweep. Keeps the most-recently-
 * recorded representative.
 */
function dedupeAndSortFacts(rows: GraphFactRow[]): GraphFactRow[] {
  const byKey = new Map<string, GraphFactRow>();
  for (const f of rows) {
    const key = `${f.predicate}::${f.object}`;
    const prev = byKey.get(key);
    const ts = (r: GraphFactRow) => new Date(r.recordedAt ?? 0).getTime();
    if (!prev || ts(f) > ts(prev)) {
      byKey.set(key, f);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      new Date(b.recordedAt ?? 0).getTime() -
      new Date(a.recordedAt ?? 0).getTime(),
  );
}
