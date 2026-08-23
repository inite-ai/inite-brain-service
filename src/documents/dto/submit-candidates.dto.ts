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
}
