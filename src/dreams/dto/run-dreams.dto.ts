import { IsArray, IsIn, IsOptional } from 'class-validator';

export type DreamsOperation = 'dedup' | 'resolve' | 'summarize';

/**
 * Body of `POST /v1/dreams/run`. Caller picks which sub-operations
 * to run; default is all enabled ones. The summarize op is normally
 * triggered by compaction — exposed here for force-runs (e.g. after
 * a bulk import that needs immediate rollups).
 */
export class RunDreamsDto {
  @IsOptional()
  @IsArray()
  @IsIn(['dedup', 'resolve', 'summarize'], { each: true })
  operations?: DreamsOperation[];
}
