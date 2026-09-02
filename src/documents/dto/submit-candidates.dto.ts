import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * An EXTERNAL indexer's reading of a stored document — the
 * POST /v1/documents/:id/candidates body. Top-level shape is
 * class-validated; the per-item shapes are service-validated
 * (nested unions don't survive the global whitelist pipe — the
 * source.evidence precedent).
 *
 * entityIndex references are LOCAL to this batch, extractor-style.
 */
export interface SubmittedEntity {
  name: string;
  type?: string;
  canonical?: string;
}

export interface SubmittedFact {
  entityIndex: number;
  /** Must be namespaced `<indexerId>__*` or a core predicate. */
  predicate: string;
  object: string;
  confidence?: number;
  clause?: string;
}

export interface SubmittedRelation {
  fromEntityIndex: number;
  toEntityIndex: number;
  kind: string;
  confidence?: number;
}

/**
 * A pack-schema-conforming scene hypothesis (candidate kind 'scene',
 * migration 0110). `schemaId` must be one of the submitting pack's own
 * declared memoryModel.sceneSchemas ids. Accepted only when
 * PACK_MEMORY_PROJECTIONS_ENABLED is on (default off — submissions
 * carrying scenes are rejected, so the flag-off surface is byte-identical
 * for every existing client).
 */
export interface SubmittedScene {
  /** ∈ the pack's memoryModel.sceneSchemas[].id. */
  schemaId: string;
  /** Short human label (≤200 chars — the 0106 sceneLabel cap). */
  label: string;
  /** Scene gist text (≤2000 chars). */
  gist: string;
  /** ISO datetime bounds; both or neither, from ≤ to. */
  occurredFrom?: string;
  occurredTo?: string;
  confidence?: number;
}

/**
 * A lifecycle-transition claim (candidate kind 'state_delta', 0110)
 * validated against the submitting pack's memoryModel.stateModels:
 * `stateModelId` must be declared and `to`/`from` must be declared states
 * (declared transitions are advisory vocabulary, never a gate — the
 * manifest contract). `sceneIndex` references a scene of THIS batch
 * (extractor index-linking, the entityIndex precedent): deltas ride their
 * scene's projected memory_episode row.
 */
export interface SubmittedStateDelta {
  /** Index into this submission's `scenes` array. */
  sceneIndex: number;
  /** ∈ the pack's memoryModel.stateModels[].id. */
  stateModelId: string;
  /** The subject whose lifecycle moved (free text, ≤256 chars). */
  subject: string;
  /** Declared state of the model, when the prior state is known. */
  from?: string;
  /** Declared state of the model. */
  to: string;
  confidence?: number;
}

/**
 * OpenAPI mirror: src/contracts/documents/documents.schema.ts
 * (SubmitCandidatesRequestSchema) — keep field names/optionality/caps in
 * lockstep and regenerate docs/openapi.json on change.
 */
export class SubmitCandidatesDto {
  /** The pack id this indexer is registered as (indexer.mode 'external'). */
  @IsString()
  @MaxLength(64)
  indexerId!: string;

  /** Optional claim of the pack version; must match the installed one. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  packVersion?: string;

  /**
   * A claimed work item (POST /v1/indexer/work/:runId/claim) this
   * submission fulfils. Provided together with claimToken or not at all;
   * without them the submission opens its own run (claimless flow).
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  runId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  claimToken?: string;

  @IsArray()
  entities!: SubmittedEntity[];

  @IsArray()
  facts!: SubmittedFact[];

  @IsOptional()
  @IsArray()
  relations?: SubmittedRelation[];

  /** 0110 episodic-plane arrays — rejected while
   *  PACK_MEMORY_PROJECTIONS_ENABLED is off (default), so the flag-off
   *  surface is byte-identical. Item shapes are service-validated against
   *  the submitting pack's own memoryModel declarations. */
  @IsOptional()
  @IsArray()
  scenes?: SubmittedScene[];

  @IsOptional()
  @IsArray()
  stateDeltas?: SubmittedStateDelta[];
}
