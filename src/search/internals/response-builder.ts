import { countJsonTokens } from '../../common/token-counter';
import type { SearchDto } from '../dto/search.dto';
import type { SearchHit } from '../search.types';
import type { EntityBucket, FactRow } from './types';

/**
 * Assemble final SearchHit rows from a reranked top-K bucket list plus
 * the backfilled per-entity fact map. Two-stage fact rendering:
 *   1. Matched facts first, sorted by score (existing behaviour).
 *   2. Backfill — pick at most ONE fact per NEW predicate not already
 *      represented in matched. Recency breaks per-predicate ties.
 *      Predicate-diverse instead of pure recency because the
 *      per-predicate eval surfaced that recency-only order buries
 *      dob/address under repeated occupation/genre facts on
 *      wikidata-shape entities.
 *
 * Cap at 5 — unchanged. The diversity step is what makes the cap
 * useful: a query for "Anton Chekhov born 1860" gets {name, dob,
 * address, occupation, genre} instead of {name, occupation×4} and
 * the eval-side fact-predicate assertion passes.
 */
export function assembleHits(
  topEntities: EntityBucket[],
  backfillByEntity: Map<string, FactRow[]>,
  entityTypes: string[] | undefined,
): SearchHit[] {
  return topEntities
    .filter((e) => {
      if (!entityTypes) return true;
      const ent = e.facts[0]?.row.entity;
      return ent ? entityTypes.includes(ent.type) : false;
    })
    .map((e) => {
      const ent = e.facts[0]?.row.entity ?? {
        id: e.entityId,
        type: 'other',
        canonicalName: e.entityId,
        externalRefs: {},
      };
      // Merge externalRefs across all facts in the bucket. After
      // identity-merge re-attribution, the bucket contains both the
      // survivor's own facts (carrying survivor refs only) and the
      // loser's facts (now carrying merged refs); the union is the
      // right display so cross-vertical refs all resolve to the same
      // hit.
      const mergedRefs: Record<string, string> = {};
      for (const sf of e.facts) {
        const refs = sf.row.entity?.externalRefs;
        if (refs) Object.assign(mergedRefs, refs);
      }
      const matchedFactIds = new Set(e.facts.map((sf) => String(sf.row.id)));
      const matchedRender = e.facts
        .sort((a, b) => b.score - a.score)
        .map(({ row, score }) => ({
          factId: String(row.id),
          predicate: row.predicate,
          object: row.object,
          confidence: row.confidence,
          validFrom: row.validFrom,
          validUntil: row.validUntil ?? undefined,
          status: row.status,
          score,
        }));
      const matchedPredicates = new Set(matchedRender.map((f) => f.predicate));
      const backfillRows = (backfillByEntity.get(e.entityId) ?? [])
        .filter((r) => !matchedFactIds.has(String(r.id)))
        .sort(
          (a, b) =>
            new Date(b.recordedAt).getTime() -
            new Date(a.recordedAt).getTime(),
        );
      const backfillRender: typeof matchedRender = [];
      const seenPredicates = new Set(matchedPredicates);
      for (const row of backfillRows) {
        if (seenPredicates.has(row.predicate)) continue;
        seenPredicates.add(row.predicate);
        backfillRender.push({
          factId: String(row.id),
          predicate: row.predicate,
          object: row.object,
          confidence: row.confidence,
          validFrom: row.validFrom,
          validUntil: row.validUntil ?? undefined,
          status: row.status,
          score: 0,
        });
      }
      return {
        entityId: e.entityId,
        entityType: ent.type,
        canonicalName: ent.canonicalName,
        externalRefs: mergedRefs,
        facts: [...matchedRender, ...backfillRender].slice(0, 5),
        score: e.bestScore,
      };
    });
}

/**
 * Apply post-hits KnowQL-lite shaping: confidenceFloor, outputShape,
 * tokenBudget. Pure transforms — input list is not mutated.
 *
 * confidenceFloor — stricter than DTO.minConfidence (which gates raw
 * fact field). Applied AFTER decay×confidence weighting, so it shapes
 * "agent's confidence in the answer".
 *
 * outputShape — `compact` keeps only the top fact per entity (score
 * stripped); `ids` strips facts entirely, keeping entity headers.
 *
 * tokenBudget — drop entities (lowest-score first) until the
 * serialised payload fits. Tokens counted exactly via tiktoken
 * (cl100k_base) on the JSON-serialised body — same encoding the
 * downstream OpenAI/Anthropic billing uses, so the budget the caller
 * specifies is the budget they'll actually consume.
 */
export function applyOutputShaping(
  hits: SearchHit[],
  dto: SearchDto,
): SearchHit[] {
  let results = hits;
  if (dto.confidenceFloor !== undefined) {
    const floor = dto.confidenceFloor;
    results = results
      .map((r) => ({
        ...r,
        facts: r.facts.filter((f) => f.score >= floor),
      }))
      .filter((r) => r.facts.length > 0);
  }
  const shape = dto.outputShape ?? 'full';
  if (shape === 'compact') {
    results = results.map((r) => ({
      ...r,
      facts: r.facts.slice(0, 1).map((f) => ({
        ...f,
        score: undefined as unknown as number,
      })),
    }));
  } else if (shape === 'ids') {
    results = results.map((r) => ({
      entityId: r.entityId,
      entityType: r.entityType,
      canonicalName: r.canonicalName,
      externalRefs: {},
      facts: [],
      score: r.score,
    }));
  }
  if (dto.tokenBudget !== undefined) {
    const budget = dto.tokenBudget;
    const fitsBudget = (xs: SearchHit[]) =>
      countJsonTokens({ results: xs }) <= budget;
    while (results.length > 0 && !fitsBudget(results)) {
      results.pop();
    }
  }
  return results;
}
