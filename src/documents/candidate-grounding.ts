/**
 * Server-side re-grounding for EXTERNAL indexer submissions: an external
 * service cannot fabricate verbatim spans — every entity name and every
 * fact value must actually appear in the stored document text, checked
 * with the SAME normalization + word-boundary rules the in-process
 * extractor's grounding gate uses (extractor-internals/grounding).
 *
 * Entities that fail grounding drop together with their facts/relations
 * (an ungrounded subject makes the claims unanchorable). Documents stored
 * WITHOUT content (storeContent:false) cannot be re-validated — the
 * caller stamps those candidates `ungrounded: true` instead and lets
 * source-trust learning compensate.
 *
 * Pure module — unit-testable without a DB.
 */
import {
  isGroundedSpan,
  normalizeForGrounding,
} from '../ai/extractor-internals/grounding';
import type {
  CandidateEntity,
  CandidateFact,
  CandidateRelation,
} from '../indexers/candidate.types';

export interface GroundingDrop {
  kind: 'entity' | 'fact' | 'relation';
  index: number;
  reason: 'ungrounded_entity' | 'ungrounded_value' | 'orphan_reference';
  detail: string;
}

export interface GroundedBatch {
  entities: CandidateEntity[];
  facts: CandidateFact[];
  relations: CandidateRelation[];
  dropped: GroundingDrop[];
}

export function groundExternalBatch(p: {
  docText: string;
  entities: CandidateEntity[];
  facts: CandidateFact[];
  relations: CandidateRelation[];
}): GroundedBatch {
  const normalizedInput = normalizeForGrounding(p.docText);
  const dropped: GroundingDrop[] = [];

  // Entities: name must appear in the document. Survivors are re-indexed
  // onto a compacted array (same remap discipline as the extractor).
  const remap = new Map<number, number>();
  const entities: CandidateEntity[] = [];
  p.entities.forEach((e, i) => {
    if (isGroundedSpan(normalizedInput, normalizeForGrounding(e.name))) {
      remap.set(i, entities.length);
      entities.push({ ...e, entityIndex: entities.length });
    } else {
      dropped.push({
        kind: 'entity',
        index: i,
        reason: 'ungrounded_entity',
        detail: e.name,
      });
    }
  });

  const facts: CandidateFact[] = [];
  p.facts.forEach((f, i) => {
    const entityIndex = remap.get(f.entityIndex);
    if (entityIndex === undefined) {
      dropped.push({
        kind: 'fact',
        index: i,
        reason: 'orphan_reference',
        detail: `${f.predicate} (entityIndex ${f.entityIndex})`,
      });
      return;
    }
    if (!isGroundedSpan(normalizedInput, normalizeForGrounding(f.object))) {
      dropped.push({
        kind: 'fact',
        index: i,
        reason: 'ungrounded_value',
        detail: `${f.predicate}="${f.object.slice(0, 80)}"`,
      });
      return;
    }
    facts.push({ ...f, entityIndex });
  });

  const relations: CandidateRelation[] = [];
  p.relations.forEach((r, i) => {
    const from = remap.get(r.fromEntityIndex);
    const to = remap.get(r.toEntityIndex);
    if (from === undefined || to === undefined) {
      dropped.push({
        kind: 'relation',
        index: i,
        reason: 'orphan_reference',
        detail: r.kind,
      });
      return;
    }
    relations.push({ ...r, fromEntityIndex: from, toEntityIndex: to });
  });

  return { entities, facts, relations, dropped };
}
