import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SearchDto } from '../../search/dto/search.dto';
import type { SynthesisGuardrails } from '../../synthesize/dto/synthesize.dto';

/**
 * MultiHopDto — extends SearchDto so all retrieval levers (limit,
 * predicates, asOf, minConfidence, ...) apply uniformly to every hop.
 * Per-hop overrides come from the planner's JSON output, not the
 * caller; the caller controls budget/limits and the synthesis layer.
 */
export class MultiHopDto extends SearchDto {
  /**
   * Hard cap on the number of hops the planner is allowed to emit.
   * Defaults to 3, capped at 5 — beyond that latency dominates.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  maxHops?: number;

  /**
   * When true, run the synthesizer on the final entity set and
   * return a grounded answer alongside the per-hop trace. Uses the
   * caller's `synthesisGuardrails` value (or the SYNTHESIZE_DEFAULT_GUARDRAILS
   * env default) — same fail-closed semantics as /v1/synthesize.
   */
  @IsOptional()
  @IsBoolean()
  synthesize?: boolean;

  /**
   * Override guardrails when `synthesize=true`. Same enum as on the
   * synthesize endpoint; ignored otherwise.
   */
  @IsOptional()
  @IsIn(['strict', 'lenient', 'off', 'answer'])
  synthesisGuardrails?: SynthesisGuardrails;

  /**
   * Override the synthesis chat model when `synthesize=true`.
   */
  @IsOptional()
  @IsString()
  synthesisModel?: string;
}
