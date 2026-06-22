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

// Letters from word-SPACED scripts (Latin + Latin-1/extended + Cyrillic).
// For these, a span embedded inside a larger word ("act" inside "active") is
// a false ground and must be rejected. Word-UNSPACED scripts (CJK, Thai, …)
// keep plain-substring semantics, because a boundary requirement there would
// drop legitimate sub-token matches (e.g. a 2-char span inside a 3-char term)
// where adjacent chars are always letters.
const SPACED_WORD_CHAR = /[A-Za-zÀ-ɏЀ-ӿ]/;

function boundaryOk(adjacent: string | undefined, edge: string): boolean {
  // This side is fine when the span's edge char isn't a spaced-script letter
  // (no boundary expected), the adjacent char is absent (string edge), or the
  // adjacent char isn't a spaced-script letter (a genuine boundary).
  if (!SPACED_WORD_CHAR.test(edge)) return true;
  return adjacent === undefined || !SPACED_WORD_CHAR.test(adjacent);
}

/**
 * Word-boundary-aware containment: is `normalizedSpan` present in
 * `normalizedInput` as a standalone token (not buried inside a larger
 * spaced-script word)? Tighter than `String.includes` so the model can't
 * ground "act" on "active", but multilingual-safe — CJK/Thai keep plain
 * substring behaviour. Both args must already be normalizeForGrounding'd.
 */
export function isGroundedSpan(
  normalizedInput: string,
  normalizedSpan: string,
): boolean {
  if (!normalizedSpan) return false;
  let from = 0;
  for (;;) {
    const idx = normalizedInput.indexOf(normalizedSpan, from);
    if (idx === -1) return false;
    const before = idx > 0 ? normalizedInput[idx - 1] : undefined;
    const after = normalizedInput[idx + normalizedSpan.length];
    if (
      boundaryOk(before, normalizedSpan[0]) &&
      boundaryOk(after, normalizedSpan[normalizedSpan.length - 1])
    ) {
      return true;
    }
    from = idx + 1;
  }
}

/**
 * Span-grounding gate for ENTITY NAMES — the parser accepts whatever name
 * the model emits, so a hallucinated entity (name never in the source) would
 * otherwise be created with full downstream effect. Returns a parallel
 * boolean mask: true = the entity's name is grounded in the input.
 */
export function groundEntities(
  trimmedInput: string,
  entities: ExtractedEntity[],
): boolean[] {
  const normalizedInput = normalizeForGrounding(trimmedInput);
  return entities.map((e) =>
    isGroundedSpan(normalizedInput, normalizeForGrounding(e.name)),
  );
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
 * as a standalone token in the original input (word-boundary aware for
 * spaced scripts, after whitespace + case normalization). The model can
 * no longer emit object="active" when the source text says "CTO", nor
 * ground "act" on a source that only contains "active".
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
    if (!isGroundedSpan(normalizedInput, normalizedSpan)) {
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
