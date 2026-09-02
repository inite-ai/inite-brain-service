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

/**
 * `ungrounded` marks a candidate whose spans could NOT be re-validated
 * against stored text (external submission on a storeContent:false
 * document). Absent = grounded or produced in-process.
 */
export interface CandidateEntity extends ExtractedEntity {
  /** Position within the producing run's entity list (extractor order). */
  entityIndex: number;
  ungrounded?: boolean;
}

export type CandidateFact = ExtractedFact & { ungrounded?: boolean };

export type CandidateRelation = ExtractedEdge & { ungrounded?: boolean };

/**
 * A pack-schema-conforming scene hypothesis (candidate kind 'scene',
 * migration 0110, PACK_MEMORY_PROJECTIONS_ENABLED). `schemaId` is fenced
 * to the submitting pack's own memoryModel.sceneSchemas at submit time.
 */
export interface CandidateScene {
  /** Position within the producing run's scene list (extractor order). */
  sceneIndex: number;
  schemaId: string;
  label: string;
  gist: string;
  occurredFrom?: Date | undefined;
  occurredTo?: Date | undefined;
  confidence: number;
  ungrounded?: boolean;
}

/**
 * A lifecycle-transition claim (candidate kind 'state_delta', 0110)
 * riding a scene of the same batch (`sceneIndex`, the entityIndex
 * precedent). Fenced to the pack's own memoryModel.stateModels.
 */
export interface CandidateStateDelta {
  sceneIndex: number;
  stateModelId: string;
  subject: string;
  from?: string | undefined;
  to: string;
  confidence: number;
  ungrounded?: boolean;
}

/**
 * One indexer's reading of one chunk. entityIndex references are LOCAL to
 * this batch — the commit step re-keys entities across batches by
 * (type, folded name) before anything touches the graph.
 * scenes/stateDeltas (0110) are absent on every in-process batch and on
 * external batches unless PACK_MEMORY_PROJECTIONS_ENABLED admitted them.
 */
export interface CandidateBatch {
  provenance: CandidateProvenance;
  entities: CandidateEntity[];
  facts: CandidateFact[];
  relations: CandidateRelation[];
  scenes?: CandidateScene[] | undefined;
  stateDeltas?: CandidateStateDelta[] | undefined;
}

/** Row-shape helpers for the `candidate` table (payload is FLEXIBLE). */
export type CandidateKind = 'entity' | 'fact' | 'relation' | 'scene' | 'state_delta';

export type CandidateStatus =
  'pending' | 'committed' | 'merged' | 'duplicate' | 'rejected' | 'expired';
