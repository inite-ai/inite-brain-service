import type { ExtractionPatternService } from '../extraction-pattern.service';
import type {
  ExtractedEdge,
  ExtractedEntity,
  ExtractedFact,
  ExtractionResult,
} from './types';
import { normalizeForGrounding } from './grounding';

/** Map a HuggingFace NER label to our closed entity-type vocabulary. */
export function mapNerTypeToEntityType(t: string): ExtractedEntity['type'] {
  const upper = (t ?? '').toUpperCase();
  if (upper === 'PER' || upper === 'PERSON') return 'staff';
  if (upper === 'ORG' || upper === 'ORGANIZATION') return 'other';
  if (upper === 'LOC' || upper === 'LOCATION') return 'location';
  return 'other';
}

/**
 * Pick the local entity that overlaps the clause text. First try
 * case-insensitive name occurrence; return -1 if no entity links.
 */
function entityIndexForFact(
  localEntities: Array<{ text: string }>,
  clauseText: string,
): number {
  const clauseLower = clauseText.toLowerCase();
  for (let i = 0; i < localEntities.length; i++) {
    const en = localEntities[i];
    if (clauseLower.includes(en.text.toLowerCase())) {
      // Heuristic: the entity is the subject of the fact when its
      // name appears inside the clause. Multiple candidates are
      // resolved by first-occurrence — good enough for the demo
      // recipe; richer disambiguation belongs to a later sprint.
      return i;
    }
  }
  return -1;
}

/**
 * Attempt to synthesise an ExtractionResult entirely from local
 * components — clauses (E2), NER (E3), and the per-tenant
 * extraction-pattern cache (E6). Returns the synthesised result when:
 *   • every local clause has a cached pattern
 *   • every cached fact's referenced entityIndex resolves to a
 *     local NER entity
 *   • every cached fact's valueSpan is a substring of the current
 *     message text (span grounding holds across replays)
 *   • every cached edge's endpoints map onto existing local entities
 *     and aren't a self-edge
 * Returns null if any check fails — caller falls back to the LLM.
 */
export async function attemptLocalSynth(
  patterns: ExtractionPatternService,
  companyId: string,
  inputText: string,
  clauseTexts: string[],
  localEntities: Array<{
    text: string;
    type: string;
    start: number;
    end: number;
    score: number;
  }>,
): Promise<ExtractionResult | null> {
  const facts: ExtractedFact[] = [];
  const edges: ExtractedEdge[] = [];
  const normalizedInput = normalizeForGrounding(inputText);

  for (const clauseText of clauseTexts) {
    const pattern = await patterns.lookup(companyId, clauseText);
    if (!pattern) return null;
    for (const f of pattern.facts) {
      const normalizedSpan = normalizeForGrounding(f.valueSpan);
      if (!normalizedInput.includes(normalizedSpan)) return null;
      const entityIndex = entityIndexForFact(localEntities, clauseText);
      if (entityIndex === -1) return null;
      facts.push({
        entityIndex,
        predicate: f.predicate,
        object: f.valueSpan,
        confidence: f.confidence,
        clause: clauseText,
      });
    }
    for (const e of pattern.edges) {
      if (
        e.fromEntityIndex >= localEntities.length ||
        e.toEntityIndex >= localEntities.length ||
        e.fromEntityIndex === e.toEntityIndex
      ) {
        return null;
      }
      edges.push({
        fromEntityIndex: e.fromEntityIndex,
        toEntityIndex: e.toEntityIndex,
        kind: e.kind,
        confidence: e.confidence,
        clause: clauseText,
      });
    }
  }
  const entities: ExtractedEntity[] = localEntities.map((e) => ({
    name: e.text,
    type: mapNerTypeToEntityType(e.type),
  }));
  return { entities, facts, edges };
}
