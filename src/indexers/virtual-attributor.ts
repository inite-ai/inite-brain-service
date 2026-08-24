/**
 * Virtual composition: split ONE union-extraction result into per-indexer
 * candidate batches by predicate namespace.
 *
 * Pack predicates are stored as `<packId>__<localId>` (PACK_NAMESPACE_SEP,
 * manifest.ts) — the union extractor's output is therefore ALREADY
 * attributable per pack with zero extra LLM calls. Facts with an
 * unprefixed (core-vocabulary) predicate attribute to 'core'. Entities and
 * relations have no predicate namespace; they stay with the physical run
 * and are attributed per-fact at commit time.
 *
 * Pure function — unit-testable without a DB or an LLM.
 */
import { PACK_NAMESPACE_SEP } from '../ai/domain-packs/manifest';
import { CORE_INDEXER_ID } from './candidate.types';
import type { ExtractedFact } from '../ai/extractor-internals/types';

/**
 * Derive the owning indexer id from a (possibly pack-namespaced)
 * predicate. `real_estate__zoned_as` → `real_estate`; `works_at` →
 * `core`. A predicate that merely CONTAINS the separator deeper in
 * (`a__b__c`) attributes to the first segment — pack ids cannot contain
 * '__' (manifest validation), so the first split is always the pack.
 */
export function indexerIdOfPredicate(predicate: string): string {
  const sep = predicate.indexOf(PACK_NAMESPACE_SEP);
  if (sep <= 0) return CORE_INDEXER_ID;
  return predicate.slice(0, sep);
}

/**
 * Group union-extracted facts by owning indexer id. Returned map keys are
 * pack ids plus 'core'; fact order within each group preserves extractor
 * order (entityIndex references stay valid — they point into the run's
 * shared entity list, not into the group).
 */
export function attributeFactsByIndexer(facts: ExtractedFact[]): Map<string, ExtractedFact[]> {
  const byIndexer = new Map<string, ExtractedFact[]>();
  for (const f of facts) {
    const indexerId = indexerIdOfPredicate(f.predicate);
    const group = byIndexer.get(indexerId);
    if (group) group.push(f);
    else byIndexer.set(indexerId, [f]);
  }
  return byIndexer;
}
