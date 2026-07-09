/**
 * Candidate shapes for the Source → Indexer → Candidates → Brain pipeline.
 *
 * An indexer reads a document chunk and produces a CandidateBatch — its
 * hypothesis about what the chunk contains. Candidates mirror the
 * extractor's ExtractionResult (index-linked entities/facts/relations)
 * plus provenance: WHICH indexer produced them, from WHICH document. They
 * are staged in the `candidate` table (migration 0049) and are NOT memory
 * until CandidateCommitService drives them through fn::resolve_fact.
 */
import type {
  ExtractedEntity,
  ExtractedFact,
  ExtractedEdge,
} from '../ai/extractor-internals/types';

/** The pack-less generalist (union) pass — today's extractor, as an indexer. */
export const GENERAL_INDEXER_ID = '_general';
/** Attribution bucket for unprefixed (core-vocabulary) predicates. */
export const CORE_INDEXER_ID = 'core';

export type IndexerExecutionMode = 'virtual' | 'dedicated' | 'external';

/**
 * Who extracted a candidate. Stamped onto every candidate row's payload;
 * on commit, `indexerId` becomes the fact's `source.recorder` (trust
 * learns per indexer via the untouched nightly refit) while the document
 * provides `source.originKey` (corroboration independence — two indexers
 * on one document are NEVER independent evidence).
 */
export interface CandidateProvenance {
  indexerId: string;
  packVersion: string;
  executionMode: IndexerExecutionMode;
  model: string | null;
}

export interface CandidateEntity extends ExtractedEntity {
  /** Position within the producing run's entity list (extractor order). */
  entityIndex: number;
}

export type CandidateFact = ExtractedFact;

export type CandidateRelation = ExtractedEdge;

/**
 * One indexer's reading of one chunk. entityIndex references are LOCAL to
 * this batch — the commit step re-keys entities across batches by
 * (type, folded name) before anything touches the graph.
 */
export interface CandidateBatch {
  provenance: CandidateProvenance;
  entities: CandidateEntity[];
  facts: CandidateFact[];
  relations: CandidateRelation[];
}

/** Row-shape helpers for the `candidate` table (payload is FLEXIBLE). */
export type CandidateKind = 'entity' | 'fact' | 'relation';

export type CandidateStatus =
  | 'pending'
  | 'committed'
  | 'merged'
  | 'duplicate'
  | 'rejected'
  | 'expired';
