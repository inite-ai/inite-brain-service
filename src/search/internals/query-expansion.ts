import type { FusedRow } from './types';

/**
 * Entity-expansion query rewrite (audit W4 #19, profile
 * entityExpansion): the first retrieval pass DISCOVERS entities the
 * query never named — the top discovered canonical names become extra
 * anchors for a second pass. This is SmartSearch's multi-session lever
 * (rule-based entity discovery on retrieved passages, 84.2 MS) done on
 * our graph rows: no NER model needed, the rows already carry their
 * entity.
 *
 * Returns null when there is nothing to expand with — every discovered
 * name already appears in the query verbatim, or the first pass came
 * back empty.
 */
const MAX_EXPANSION_NAMES = 3;

export function buildEntityExpansionQuery(
  query: string,
  rows: FusedRow[],
): string | null {
  const lower = query.toLowerCase();
  const bestByName = new Map<string, number>();
  for (const r of rows) {
    const name = r.entity?.canonicalName?.trim();
    if (!name || name.length < 3) continue;
    // Only NOVEL anchors: a name the caller already typed adds nothing
    // to either the embedding or the BM25 term set.
    if (lower.includes(name.toLowerCase())) continue;
    const prev = bestByName.get(name);
    if (prev === undefined || r.fusedScore > prev) {
      bestByName.set(name, r.fusedScore);
    }
  }
  const names = [...bestByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXPANSION_NAMES)
    .map(([n]) => n);
  if (names.length === 0) return null;
  return `${query} ${names.join(' ')}`;
}
