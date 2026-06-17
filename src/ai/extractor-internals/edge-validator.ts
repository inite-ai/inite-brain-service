import type { ExtractedEdge } from './types';

/**
 * Validate the edges[] array from the raw LLM JSON. Each edge bridges
 * two already-validated entities; dropped when an index points outside
 * entities[], or maps a self-edge, or when the kind is empty. No span
 * grounding — kind is a coined verb-shape, not a substring of the input.
 *
 * Returns surviving edges + drop diagnostics for trace emission.
 */
export function validateEdges(
  parsed: any,
  entityCount: number,
  clauses: string[],
): {
  edges: ExtractedEdge[];
  dropped: Array<{ kind?: string; reason: string }>;
} {
  const edges: ExtractedEdge[] = [];
  const dropped: Array<{ kind?: string; reason: string }> = [];
  if (!Array.isArray(parsed.edges)) return { edges, dropped };

  for (const e of parsed.edges as Array<Record<string, unknown>>) {
    if (!e || typeof e !== 'object') continue;
    const from = Number(e.fromEntityIndex);
    const to = Number(e.toEntityIndex);
    const kind =
      typeof e.kind === 'string' ? e.kind.trim().toLowerCase() : '';
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= entityCount ||
      to >= entityCount
    ) {
      dropped.push({
        kind: kind || undefined,
        reason: 'entity_index_out_of_bounds',
      });
      continue;
    }
    if (from === to) {
      dropped.push({ kind, reason: 'self_edge' });
      continue;
    }
    if (kind.length === 0) {
      dropped.push({ kind: undefined, reason: 'empty_kind' });
      continue;
    }
    const clauseIndex =
      Number.isInteger(e.clauseIndex) && (e.clauseIndex as number) >= 0
        ? (e.clauseIndex as number)
        : undefined;
    const clauseText =
      clauseIndex !== undefined && clauseIndex < clauses.length
        ? clauses[clauseIndex]
        : undefined;
    const confidence =
      typeof e.confidence === 'number'
        ? Math.max(0, Math.min(1, e.confidence))
        : 0.7;
    edges.push({
      fromEntityIndex: from,
      toEntityIndex: to,
      kind,
      confidence,
      ...(clauseText ? { clause: clauseText } : {}),
    });
  }
  return { edges, dropped };
}
