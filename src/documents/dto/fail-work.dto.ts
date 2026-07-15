import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /v1/indexer/work/:runId/fail — give a claim back. Default is a
 * RELEASE: the item returns to 'pending' and the next poll rediscovers
 * it (transient trouble, shutting down mid-work). `permanent: true`
 * marks the run 'failed' instead — "this indexer cannot process this
 * document", still reclaimable by runId but no longer offered.
 *
 * OpenAPI mirror: src/contracts/documents/documents.schema.ts
 * (FailWorkRequestSchema) — keep in lockstep.
 */
export class FailWorkDto {
  @IsString()
  @MaxLength(64)
  claimToken: string;

  /** Optional diagnostic recorded on the run row (truncated server-side). */
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  error?: string;

  @IsOptional()
  @IsBoolean()
  permanent?: boolean;
}
