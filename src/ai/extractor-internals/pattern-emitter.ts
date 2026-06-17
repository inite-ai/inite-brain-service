import type { Logger } from '@nestjs/common';
import type {
  ExtractionPatternEntry,
  ExtractionPatternService,
} from '../extraction-pattern.service';
import type {
  ExtractedEdge,
  ExtractedFact,
  RawExtractedFact,
} from './types';

/**
 * Persist per-clause extraction patterns so future ingests can replay
 * them locally. Grouped by the LLM-emitted clauseIndex. The predicate
 * is the FINAL canonical id (after local-override + EDC canonicalize),
 * not the LLM-coined name, so the cache stores the canonical form.
 *
 * Fire-and-forget: failure logs but doesn't fail the current
 * extraction. The cache will simply stay cold for those clauses.
 */
export async function persistExtractionPatterns(
  patterns: ExtractionPatternService,
  logger: Logger,
  companyId: string,
  clauses: string[],
  rawFacts: RawExtractedFact[],
  facts: ExtractedFact[],
  edges: ExtractedEdge[],
): Promise<void> {
  const entries: ExtractionPatternEntry[] = [];
  const factsByClause = new Map<number, RawExtractedFact[]>();
  for (const rf of rawFacts) {
    if (rf.clauseIndex === undefined) continue;
    const list = factsByClause.get(rf.clauseIndex) ?? [];
    list.push(rf);
    factsByClause.set(rf.clauseIndex, list);
  }
  for (let i = 0; i < clauses.length; i++) {
    const clauseText = clauses[i];
    const clauseFacts = (factsByClause.get(i) ?? []).map((f) => ({
      predicate:
        facts.find(
          (ff) =>
            ff.entityIndex === f.entityIndex &&
            ff.object === f.valueSpan &&
            ff.clause === clauseText,
        )?.predicate ?? f.predicate,
      valueSpan: f.valueSpan,
      confidence: f.confidence,
    }));
    const clauseEdges = edges
      .filter((e) => e.clause === clauseText)
      .map((e) => ({
        kind: e.kind,
        fromEntityIndex: e.fromEntityIndex,
        toEntityIndex: e.toEntityIndex,
        confidence: e.confidence,
      }));
    if (clauseFacts.length === 0 && clauseEdges.length === 0) continue;
    entries.push({ clauseText, facts: clauseFacts, edges: clauseEdges });
  }
  if (entries.length === 0) return;
  try {
    await patterns.record(companyId, entries);
  } catch (e) {
    logger.warn(
      `extraction pattern record failed for ${companyId}: ${(e as Error).message}`,
    );
  }
}
