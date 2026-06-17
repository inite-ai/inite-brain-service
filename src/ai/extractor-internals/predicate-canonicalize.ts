import type { Logger } from '@nestjs/common';
import type { LocalPredicateSelectorService } from '../local-predicate-selector.service';
import type {
  PredicateRegistryService,
  PredicateSnapshot,
} from '../predicate-registry.service';
import type { ExtractedFact } from './types';

/**
 * Local predicate selection — embed each clause and pick the canonical
 * predicate with highest cosine similarity vs the registry's per-
 * predicate description embeddings. Overrides the LLM-coined predicate
 * ONLY when local top-1 is above `threshold`.
 *
 * Mutates facts in place — predicate field is overwritten on hit.
 * Returns the override-decision list for trace emission.
 */
export async function applyLocalPredicateOverrides(
  facts: ExtractedFact[],
  snapshot: PredicateSnapshot | null,
  selector: LocalPredicateSelectorService,
  threshold: number,
): Promise<
  Array<{ original: string; override: string; similarity: number }>
> {
  const overrides: Array<{
    original: string;
    override: string;
    similarity: number;
  }> = [];
  for (const f of facts) {
    if (!f.clause) continue;
    const ranked = await selector.rank(f.clause, snapshot, 3);
    if (ranked.length === 0) continue;
    const top = ranked[0];
    if (top.similarity < threshold) continue;
    if (top.predicateId === f.predicate) continue;
    overrides.push({
      original: f.predicate,
      override: top.predicateId,
      similarity: top.similarity,
    });
    f.predicate = top.predicateId;
  }
  return overrides;
}

/**
 * EDC canonicalization pass. For each fact, ask the registry to
 * resolve the (possibly-novel) predicate to its canonical id —
 * matching an existing predicate, auto-aliasing a similar novel one,
 * or inserting it as proposed. Mutates facts in place.
 *
 * Defensive: per-fact errors are logged but don't fail the pass.
 * Returns the non-trivial decisions for trace emission.
 */
export async function applyCanonicalizePass(
  facts: ExtractedFact[],
  registry: PredicateRegistryService,
  companyId: string,
  logger: Logger,
): Promise<
  Array<{
    original: string;
    canonical: string;
    kind: 'matched' | 'aliased' | 'proposed';
    similarity?: number;
    bestMatchId?: string;
  }>
> {
  const decisions: Array<{
    original: string;
    canonical: string;
    kind: 'matched' | 'aliased' | 'proposed';
    similarity?: number;
    bestMatchId?: string;
  }> = [];
  for (const f of facts) {
    const contextText = `${f.predicate}: ${f.object}${
      f.clause ? ` (clause: ${f.clause})` : ''
    }`;
    try {
      const decision = await registry.canonicalize(
        companyId,
        f.predicate,
        contextText,
      );
      if (decision.canonicalId !== f.predicate) {
        decisions.push({
          original: f.predicate,
          canonical: decision.canonicalId,
          kind: decision.kind,
          ...(decision.kind === 'aliased'
            ? { similarity: decision.similarity }
            : {}),
          ...(decision.kind === 'proposed' && decision.bestMatch
            ? {
                similarity: decision.bestMatch.similarity,
                bestMatchId: decision.bestMatch.predicateId,
              }
            : {}),
        });
        f.predicate = decision.canonicalId;
      } else if (decision.kind !== 'matched') {
        decisions.push({
          original: f.predicate,
          canonical: decision.canonicalId,
          kind: decision.kind,
          ...(decision.kind === 'aliased'
            ? { similarity: decision.similarity }
            : {}),
        });
      }
    } catch (e) {
      logger.warn(
        `canonicalize failed for predicate '${f.predicate}': ${(e as Error).message}`,
      );
    }
  }
  return decisions;
}
