import { IsString, MaxLength } from 'class-validator';

/** POST /v1/indexer/work/:runId/heartbeat — renew a claim lease. */
export class HeartbeatWorkDto {
  @IsString()
  @MaxLength(64)
  claimToken: string;
}
