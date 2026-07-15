import { IsString, MaxLength } from 'class-validator';

/**
 * POST /v1/indexer/work/:runId/heartbeat — renew a claim lease.
 * OpenAPI mirror: src/contracts/documents/documents.schema.ts
 * (HeartbeatWorkRequestSchema) — keep in lockstep.
 */
export class HeartbeatWorkDto {
  @IsString()
  @MaxLength(64)
  claimToken: string;
}
