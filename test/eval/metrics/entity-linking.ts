/**
 * Entity-linking accuracy + fragmentation rate.
 *
 * The multilingual failure this guards: the same real-world entity
 * written across scripts (Ivan Petrov / Иван Петров / 伊万·彼得罗夫)
 * must collapse to ONE node. Two independent signals:
 *
 *   - linking accuracy   — share of surfaces linked to the RIGHT
 *     canonical entity (an aggregation-blind metric would miss a surface
 *     that linked confidently to the wrong node).
 *   - fragmentation rate — share of predicted nodes that are SURPLUS,
 *     i.e. duplicates of a gold entity that should have merged. A linker
 *     that never merges scores high accuracy on the anchor surface but
 *     fragments every alias; fragmentation rate is the metric blind to
 *     neither failure.
 *
 * Both pure — the runner feeds predicted refs / node ids in, numbers out.
 */

/**
 * Share of surfaces linked to the correct canonical entity. `predicted[i]`
 * is the ref the linker chose for surface i (null = left unlinked / minted
 * a brand-new entity); `gold[i]` is the correct canonical ref. Returns
 * null on empty input so an all-retrieval slice renders "—".
 */
export function entityLinkingAccuracy(
  predicted: Array<string | null>,
  gold: string[],
): number | null {
  if (gold.length === 0) return null;
  let correct = 0;
  for (let i = 0; i < gold.length; i++) {
    if (predicted[i] === gold[i]) correct++;
  }
  return correct / gold.length;
}

export interface FragmentationResult {
  /** (distinctNodes − goldEntities) / distinctNodes — fraction of nodes
   *  that are surplus duplicates. 0 = perfect (one node per entity). null
   *  when no nodes were produced. */
  fragmentationRate: number | null;
  /** distinctNodes / goldEntities — 1.0 ideal, >1 means over-splitting. */
  duplicatesPerEntity: number | null;
  /** Count of gold entities whose surfaces landed in more than one node. */
  fragmentedEntities: number;
  goldEntities: number;
  /** Total distinct predicted nodes summed across gold entities. */
  predictedNodes: number;
}

/**
 * Fragmentation over per-surface node assignments. Each record ties a
 * surface's gold entity to the node id the linker placed it in. Groups by
 * gold entity, counts distinct node ids per entity, and reports how many
 * nodes are surplus.
 */
export function fragmentationRate(
  records: Array<{ goldEntity: string; nodeId: string }>,
): FragmentationResult {
  if (records.length === 0) {
    return {
      fragmentationRate: null,
      duplicatesPerEntity: null,
      fragmentedEntities: 0,
      goldEntities: 0,
      predictedNodes: 0,
    };
  }
  const nodesByEntity = new Map<string, Set<string>>();
  for (const r of records) {
    const set = nodesByEntity.get(r.goldEntity) ?? new Set<string>();
    set.add(r.nodeId);
    nodesByEntity.set(r.goldEntity, set);
  }
  let predictedNodes = 0;
  let fragmentedEntities = 0;
  for (const set of nodesByEntity.values()) {
    predictedNodes += set.size;
    if (set.size > 1) fragmentedEntities++;
  }
  const goldEntities = nodesByEntity.size;
  return {
    fragmentationRate:
      predictedNodes === 0 ? null : (predictedNodes - goldEntities) / predictedNodes,
    duplicatesPerEntity: goldEntities === 0 ? null : predictedNodes / goldEntities,
    fragmentedEntities,
    goldEntities,
    predictedNodes,
  };
}
