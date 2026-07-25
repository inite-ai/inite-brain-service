import { clusterKey, selfConsistencyByFact } from './semantic-entropy';
import type { ExtractionResult } from './types';

/**
 * Union several independent extractions of the SAME text into one result.
 *
 * Used by both multi-pass extraction (`EXTRACTOR_SC_PASSES`, N re-rolls of one
 * prompt) and facet routing (`EXTRACTOR_ROUTING_ENABLED`, N specialist prompts).
 *
 * ⚠️ INDEX REMAPPING IS THE WHOLE POINT. Each pass returns its OWN `entities`
 * array, and its facts/edges address entities by POSITION in that array. Merging
 * the entity arrays therefore renumbers everything: a fact from pass 2 with
 * `entityIndex: 0` means "pass 2's first entity", which after the merge may sit
 * at index 4 — or be a different entity entirely. The pre-existing multi-pass
 * merge carried raw indices across the union, which silently mis-attributed
 * facts whenever two passes ordered their entities differently. Same-prompt
 * re-rolls usually agree, which is why it survived; facet passes never do (the
 * named-entity pass emits only proper nouns), so the union must remap.
 *
 * Deduplication: entities by (type, lowercased name); facts by semantic cluster
 * key; edges by (from-entity identity, kind, to-entity identity) — identity,
 * not position, for the same reason.
 */
export function mergeExtractions(
  passes: ExtractionResult[],
  opts: { selfConsistency?: boolean } = {},
): ExtractionResult & { clusterCount: number } {
  const entityKey = (e: { name: string; type: string }) =>
    `${e.type}:${e.name.toLowerCase().trim()}`;

  // Merged entity table + per-pass index → merged index.
  const entities: ExtractionResult['entities'] = [];
  const entityAt = new Map<string, number>();
  const remaps: Array<Map<number, number>> = [];
  for (const pass of passes) {
    const remap = new Map<number, number>();
    pass.entities.forEach((e, i) => {
      const k = entityKey(e);
      let idx = entityAt.get(k);
      if (idx === undefined) {
        idx = entities.length;
        entities.push(e);
        entityAt.set(k, idx);
      }
      remap.set(i, idx);
    });
    remaps.push(remap);
  }

  // Self-consistency stats are only meaningful across re-rolls of the SAME
  // prompt. Across facets, passes look for different things by construction, so
  // "only 1 of 3 passes found it" says nothing about confidence.
  const sc = opts.selfConsistency
    ? selfConsistencyByFact(
        passes.map((r) =>
          r.facts.map((f) => ({ predicate: f.predicate, object: f.object })),
        ),
      )
    : null;

  const seenClusters = new Set<string>();
  const facts: ExtractionResult['facts'] = [];
  passes.forEach((pass, p) => {
    for (const f of pass.facts) {
      const entityIndex = remaps[p].get(f.entityIndex);
      if (entityIndex === undefined) continue;
      const k = clusterKey({ predicate: f.predicate, object: f.object });
      if (seenClusters.has(k)) continue;
      seenClusters.add(k);
      const stats = sc?.get(k);
      facts.push({
        ...f,
        entityIndex,
        ...(stats
          ? {
              extractionEntropy: stats.entropy,
              extractionAgreement: stats.agreement,
            }
          : {}),
      });
    }
  });

  const edges: ExtractionResult['edges'] = [];
  const seenEdges = new Set<string>();
  passes.forEach((pass, p) => {
    for (const ed of pass.edges) {
      const from = remaps[p].get(ed.fromEntityIndex);
      const to = remaps[p].get(ed.toEntityIndex);
      if (from === undefined || to === undefined) continue;
      const k = `${from}-${ed.kind}-${to}`;
      if (seenEdges.has(k)) continue;
      seenEdges.add(k);
      edges.push({ ...ed, fromEntityIndex: from, toEntityIndex: to });
    }
  });

  return { entities, facts, edges, clusterCount: sc?.size ?? facts.length };
}
