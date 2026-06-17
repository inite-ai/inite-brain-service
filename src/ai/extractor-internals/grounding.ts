import type {
  ExtractedEntity,
  ExtractedFact,
  RawExtractedFact,
} from './types';

/**
 * Whitespace-collapsed, lower-cased view of a string used for
 * substring containment checks in span grounding. The same transform
 * is applied to both the input and the claimed valueSpan so the model
 * doesn't have to match the exact whitespace / casing of the source —
 * but it still has to choose tokens that actually appeared.
 */
export function normalizeForGrounding(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

const ALLOWED_ENTITY_TYPES = new Set([
  'customer',
  'staff',
  'asset',
  'project',
  'topic',
  'location',
  'other',
]);

export function normalizeEntityType(t: unknown): ExtractedEntity['type'] {
  if (typeof t === 'string' && ALLOWED_ENTITY_TYPES.has(t)) {
    return t as ExtractedEntity['type'];
  }
  return 'other';
}

/** Parse the entities[] array from the raw LLM JSON. */
export function parseEntities(parsed: any): ExtractedEntity[] {
  if (!Array.isArray(parsed.entities)) return [];
  return parsed.entities
    .filter((e: any) => e && typeof e.name === 'string')
    .map((e: any) => ({
      name: String(e.name).trim(),
      type: normalizeEntityType(e.type),
      canonical:
        e.canonical && typeof e.canonical === 'string'
          ? e.canonical.trim()
          : undefined,
    }));
}

/** Parse the clauses[] array — verbatim string sub-spans. */
export function parseClauses(parsed: any): string[] {
  if (!Array.isArray(parsed.clauses)) return [];
  return parsed.clauses.filter((c: unknown) => typeof c === 'string');
}

/**
 * Pull raw facts out of the LLM JSON with shallow shape validation —
 * entityIndex in bounds, predicate is a string, valueSpan is a string.
 */
export function parseRawFacts(
  parsed: any,
  entityCount: number,
): RawExtractedFact[] {
  if (!Array.isArray(parsed.facts)) return [];
  return parsed.facts
    .filter(
      (f: any) =>
        f &&
        Number.isInteger(f.entityIndex) &&
        f.entityIndex >= 0 &&
        f.entityIndex < entityCount &&
        typeof f.predicate === 'string' &&
        typeof f.valueSpan === 'string',
    )
    .map((f: any) => ({
      entityIndex: f.entityIndex,
      clauseIndex:
        Number.isInteger(f.clauseIndex) && f.clauseIndex >= 0
          ? f.clauseIndex
          : undefined,
      predicate: String(f.predicate).trim(),
      valueSpan: String(f.valueSpan).trim(),
      confidence:
        typeof f.confidence === 'number'
          ? Math.max(0, Math.min(1, f.confidence))
          : 0.5,
    }));
}

/**
 * Span-grounding gate. A fact survives ONLY if its valueSpan appears
 * as a substring of the original input (after whitespace + case
 * normalization). The model can no longer emit object="active" when
 * the source text says "CTO".
 *
 * Returns the surviving ExtractedFact[] and the dropped diagnostics
 * for trace emission.
 */
export function applyGroundingGate(
  trimmedInput: string,
  rawFacts: RawExtractedFact[],
  clauses: string[],
): {
  facts: ExtractedFact[];
  dropped: Array<{
    predicate: string;
    claimedValueSpan: string;
    reason: 'not_grounded' | 'empty';
  }>;
} {
  const normalizedInput = normalizeForGrounding(trimmedInput);
  const facts: ExtractedFact[] = [];
  const dropped: Array<{
    predicate: string;
    claimedValueSpan: string;
    reason: 'not_grounded' | 'empty';
  }> = [];

  for (const rf of rawFacts) {
    if (!rf.valueSpan) {
      dropped.push({
        predicate: rf.predicate,
        claimedValueSpan: rf.valueSpan,
        reason: 'empty',
      });
      continue;
    }
    const normalizedSpan = normalizeForGrounding(rf.valueSpan);
    if (!normalizedInput.includes(normalizedSpan)) {
      dropped.push({
        predicate: rf.predicate,
        claimedValueSpan: rf.valueSpan,
        reason: 'not_grounded',
      });
      continue;
    }
    const clauseText =
      rf.clauseIndex !== undefined && rf.clauseIndex < clauses.length
        ? clauses[rf.clauseIndex]
        : undefined;
    facts.push({
      entityIndex: rf.entityIndex,
      predicate: rf.predicate,
      object: rf.valueSpan,
      confidence: rf.confidence,
      clause: clauseText,
    });
  }

  return { facts, dropped };
}
