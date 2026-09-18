import { knownEntityId, supersededFactIds, type MemoryContext } from './memory-context';
import {
  parseCardinality,
  type ExtractedEntity,
  type ExtractedFact,
  type RawExtractedFact,
} from './types';
import type { ExtractionPipelineProfile } from '../extraction-profile';

/**
 * Whitespace-collapsed, lower-cased view of a string used for
 * substring containment checks in span grounding. The same transform
 * is applied to both the input and the claimed valueSpan so the model
 * doesn't have to match the exact whitespace / casing of the source —
 * but it still has to choose tokens that actually appeared.
 */
/**
 * Object-normalization master switch. The open (dialogue) vocabulary
 * already emits normalized values through its own contract, so it wins:
 * object normalization only applies on the span-grounded closed
 * profile. Default off — extraction prompt changes have produced
 * measured regressions before (agent-qa 47.4→42.1 rollback); this one
 * gets a paid confirm leg before any default flip.
 */
export function objectNormalizationEnabled(profile: ExtractionPipelineProfile): boolean {
  return profile.vocabulary === 'closed' && profile.normalizeObjects;
}

export function normalizeForGrounding(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Object-shape guard for narrowing raw LLM JSON before field access. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
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
export function isGroundedSpan(normalizedInput: string, normalizedSpan: string): boolean {
  if (!normalizedSpan) return false;
  let from = 0;
  for (;;) {
    const idx = normalizedInput.indexOf(normalizedSpan, from);
    if (idx === -1) return false;
    const before = idx > 0 ? normalizedInput[idx - 1] : undefined;
    const after = normalizedInput[idx + normalizedSpan.length];
    if (
      boundaryOk(before, normalizedSpan[0]!) && // non-empty (checked line 60)
      boundaryOk(after, normalizedSpan[normalizedSpan.length - 1]!)
    ) {
      return true;
    }
    from = idx + 1;
  }
}

/**
 * Inflection-tolerant grounding for ENTITY NAMES in spaced scripts. The
 * extractor files an entity under its dictionary form — "Мария Петрова"
 * for the mention "Марией Петровой", "Лиссабон" for "Лиссабона" — and the
 * verbatim gate then dropped the entity as a hallucination, with its facts.
 * On the prod tenant the interviewee vanished from her own interview. A
 * fusional language inflects by SUFFIX, so a name token is present when an
 * input token shares its stem: a common prefix of at least four letters
 * (three on a three-letter token) covering 70% of the shorter token
 * ("мария"/"марией" → "мари", 4 of 5; "петрова"/"петровой" → "петров", 6
 * of 7; "bern"/"berlin" → "ber", 3 of 4: no). Every token of the name must
 * find one; short tokens (initials, "de", "of") are skipped rather than
 * matched loosely. Unspaced scripts keep the verbatim gate (no suffixes to
 * tolerate), and so does every fact valueSpan — a citation must quote.
 */
export function isGroundedInflected(normalizedInput: string, normalizedName: string): boolean {
  const inputTokens = normalizedInput.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
  if (inputTokens.length === 0) return false;
  const nameTokens = normalizedName.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
  if (nameTokens.length === 0) return false;
  return nameTokens.every((nt) => {
    if (!SPACED_WORD_CHAR.test(nt[0]!)) return false;
    return inputTokens.some((it) => {
      const shorter = Math.min(nt.length, it.length);
      const need = Math.max(Math.min(4, shorter), Math.ceil(0.7 * shorter));
      let i = 0;
      while (i < nt.length && i < it.length && nt[i] === it[i]) i++;
      return i >= need;
    });
  });
}

/**
 * Span-grounding gate for ENTITY NAMES — the parser accepts whatever name
 * the model emits, so a hallucinated entity (name never in the source) would
 * otherwise be created with full downstream effect. Returns a parallel
 * boolean mask: true = the entity's name is grounded in the input, verbatim
 * or as an inflected form of it (isGroundedInflected).
 */
export function groundEntities(
  trimmedInput: string,
  entities: ExtractedEntity[],
  /**
   * Names that are grounded by construction even when absent from the raw
   * text — the known conversation participants (speaker/addressee). A turn
   * spoken by Caroline that says only "I decided to transition" legitimately
   * has the resolved name "Caroline" nowhere in its verbatim span; without
   * this allowlist the coreference-resolved entity would be dropped and its
   * facts lost.
   */
  allowedNames: string[] = [],
): boolean[] {
  const normalizedInput = normalizeForGrounding(trimmedInput);
  const allowed = new Set(allowedNames.map((n) => normalizeForGrounding(n)).filter(Boolean));
  return entities.map((e) => {
    // A mention pinned to a KNOWN ENTITY (memory-context.ts) is grounded
    // by construction: the pin is a resolution the graph issued the
    // handle for, and the extractor routinely writes the entity's known
    // name for a short mention ("Rui" → "Rui Almeida"). Dropping it
    // here lost every fact of the turn (measured 2026-09-18).
    if (e.known) return true;
    const normName = normalizeForGrounding(e.name);
    return (
      allowed.has(normName) ||
      isGroundedSpan(normalizedInput, normName) ||
      isGroundedInflected(normalizedInput, normName)
    );
  });
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
export function parseEntities(parsed: unknown, memory?: MemoryContext): ExtractedEntity[] {
  const entities = isRecord(parsed) ? parsed.entities : undefined;
  if (!Array.isArray(entities)) return [];
  const out: ExtractedEntity[] = [];
  for (const e of entities as unknown[]) {
    if (!isRecord(e) || typeof e.name !== 'string') continue;
    // A handle the memory context did not issue maps to nothing — the
    // mention then resolves like any other.
    const known = knownEntityId(memory, e.known);
    out.push({
      name: e.name.trim(),
      type: normalizeEntityType(e.type),
      canonical: typeof e.canonical === 'string' ? e.canonical.trim() : undefined,
      ...(known ? { known } : {}),
    });
  }
  return out;
}

/** A calendar day the extractor resolved, or undefined for anything else. */
export function parseEventTime(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return undefined;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const ms = Date.parse(`${day}T00:00:00Z`);
  // A real day only: "2026-02-30" parses to March on some engines.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return undefined;
  return day;
}

/** Parse the clauses[] array — verbatim string sub-spans. */
export function parseClauses(parsed: unknown): string[] {
  const clauses = isRecord(parsed) ? parsed.clauses : undefined;
  if (!Array.isArray(clauses)) return [];
  return (clauses as unknown[]).filter((c): c is string => typeof c === 'string');
}

/**
 * Pull raw facts out of the LLM JSON with shallow shape validation —
 * entityIndex in bounds, predicate is a string, valueSpan is a string.
 */
export function parseRawFacts(
  parsed: unknown,
  entityCount: number,
  memory?: MemoryContext,
): RawExtractedFact[] {
  const facts = isRecord(parsed) ? parsed.facts : undefined;
  if (!Array.isArray(facts)) return [];
  const out: RawExtractedFact[] = [];
  for (const f of facts as unknown[]) {
    if (
      !isRecord(f) ||
      typeof f.entityIndex !== 'number' ||
      !Number.isInteger(f.entityIndex) ||
      f.entityIndex < 0 ||
      f.entityIndex >= entityCount ||
      typeof f.predicate !== 'string' ||
      typeof f.valueSpan !== 'string'
    ) {
      continue;
    }
    const eventTime = parseEventTime(f.eventTime);
    const cardinality = parseCardinality(f.cardinality);
    // Handles are mapped to record ids here; invented ones vanish.
    const supersedes = supersededFactIds(memory, f.supersedes);
    out.push({
      entityIndex: f.entityIndex,
      clauseIndex:
        typeof f.clauseIndex === 'number' && Number.isInteger(f.clauseIndex) && f.clauseIndex >= 0
          ? f.clauseIndex
          : undefined,
      predicate: f.predicate.trim(),
      valueSpan: f.valueSpan.trim(),
      confidence: typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.5,
      ...(typeof f.object === 'string' && f.object.trim() ? { object: f.object.trim() } : {}),
      ...(eventTime ? { eventTime } : {}),
      ...(supersedes.length > 0 ? { supersedes } : {}),
      ...(cardinality ? { cardinality } : {}),
    });
  }
  return out;
}

/**
 * Normalized-object gate (EXTRACTION_OBJECT_NORMALIZE): the proposed
 * clean value may only DROP words from the grounded span, never add
 * them — every token of the object must appear among the span's tokens
 * (after the same normalization the span gate uses). This keeps
 * anti-hallucination structural: "camped in the mountains with my kids"
 * admits "the mountains" and rejects "hiking trip".
 */
export function isObjectGroundedInSpan(valueSpan: string, object: string): boolean {
  const spanTokens = new Set(normalizeForGrounding(valueSpan).split(/\s+/).filter(Boolean));
  const objTokens = normalizeForGrounding(object).split(/\s+/).filter(Boolean);
  if (objTokens.length === 0) return false;
  return objTokens.every((t) => spanTokens.has(t));
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
  opts: {
    /** Clause spans the facts index into, for clause attribution. */
    clauses: string[];
    /**
     * Dialogue profile (Phase 4): the extractor emits NORMALIZED values that
     * are intentionally not verbatim substrings ("single" for "not seeing
     * anyone"). When true, a value that fails the substring check is KEPT
     * rather than dropped — normalization IS the point. Empty values are still
     * dropped (no value to store). Default false → verbatim gate unchanged.
     */
    allowUngrounded?: boolean;
    /**
     * EXTRACTION_OBJECT_NORMALIZE: accept the LLM's proposed normalized
     * object when every word of it appears in the grounded span; fall
     * back to the span otherwise. Off → objects are the raw spans,
     * byte-identical to before.
     */
    normalizeObjects?: boolean;
  },
): {
  facts: ExtractedFact[];
  dropped: Array<{
    predicate: string;
    claimedValueSpan: string;
    reason: 'not_grounded' | 'empty';
  }>;
  /** Rejected normalization proposals (word outside the span) for trace. */
  ungroundedObjects: Array<{
    predicate: string;
    claimedObject: string;
    valueSpan: string;
  }>;
} {
  const { clauses, allowUngrounded = false, normalizeObjects = false } = opts;
  const normalizedInput = normalizeForGrounding(trimmedInput);
  const facts: ExtractedFact[] = [];
  const dropped: Array<{
    predicate: string;
    claimedValueSpan: string;
    reason: 'not_grounded' | 'empty';
  }> = [];
  const ungroundedObjects: Array<{
    predicate: string;
    claimedObject: string;
    valueSpan: string;
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
    if (!allowUngrounded && !isGroundedSpan(normalizedInput, normalizedSpan)) {
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
    let object = rf.valueSpan;
    if (normalizeObjects && rf.object && rf.object !== rf.valueSpan) {
      if (isObjectGroundedInSpan(rf.valueSpan, rf.object)) {
        object = rf.object;
      } else {
        ungroundedObjects.push({
          predicate: rf.predicate,
          claimedObject: rf.object,
          valueSpan: rf.valueSpan,
        });
      }
    }
    facts.push({
      entityIndex: rf.entityIndex,
      predicate: rf.predicate,
      object,
      confidence: rf.confidence,
      clause: clauseText,
      valueSpan: rf.valueSpan,
      ...(rf.eventTime ? { eventTime: rf.eventTime } : {}),
      ...(rf.supersedes && rf.supersedes.length > 0 ? { supersedes: rf.supersedes } : {}),
      ...(rf.cardinality ? { cardinality: rf.cardinality } : {}),
    });
  }

  return { facts, dropped, ungroundedObjects };
}
