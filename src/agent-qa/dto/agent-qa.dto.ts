import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * AgentQaDto — a free-text question the agent-in-loop answers by iteratively
 * searching memory. Deliberately minimal: the agent picks its own search
 * queries, so the caller supplies only the question (+ an optional asOf
 * bitemporal cursor threaded into each search).
 */
export class AgentQaDto {
  @IsString()
  @MaxLength(2_000)
  query: string;

  @IsOptional()
  @IsISO8601()
  asOf?: string;
}
