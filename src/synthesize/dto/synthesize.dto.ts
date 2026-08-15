import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { SearchDto } from '../../search/dto/search.dto';

export type SynthesisGuardrails = 'strict' | 'lenient' | 'off' | 'answer';

/**
 * SynthesizeDto extends SearchDto so all retrieval levers
 * (predicates, asOf, minConfidence, searchMode, tokenBudget, ...)
 * are available on the synthesize endpoint without re-declaration.
 * The added fields are synthesis-only.
 */
export class SynthesizeDto extends SearchDto {
  /**
   * Override the chat model used for the synthesis + verifier calls.
   * Defaults to OPENAI_CHAT_MODEL.
   */
  @IsOptional()
  @IsString()
  synthesisModel?: string;

  /**
   * Guardrail mode (corrective-RAG style):
   *   strict   — verifier-LLM judges every claim in the answer for
   *              support against the retrieved facts. Unsupported →
   *              `answer: null`, `reason: 'verifier_failed'`. Default.
   *   lenient  — verifier still runs, but the answer is returned even
   *              on partial / unsupported verdicts; `reason` carries
   *              the verifier's verdict for the caller to decide.
   *   off      — skip verifier altogether (cheapest; for callers that
   *              do their own grounding downstream).
   *   answer   — best-effort / never-abstain: the generator always emits a
   *              short concrete answer from the retrieved facts and never
   *              returns the "no grounded evidence" refusal; verifier is
   *              skipped. For QA settings (e.g. benchmark answering) where an
   *              abstention scores worse than a best-guess answer.
   */
  @IsOptional()
  @IsIn(['strict', 'lenient', 'off', 'answer'])
  synthesisGuardrails?: SynthesisGuardrails;

  /**
   * Emit a per-fact reasoning trace (DecisionLog) alongside the answer.
   * Off by default to keep the response surface stable for existing
   * callers and to avoid leaking score components when not needed.
   *
   * When true, `SynthesizeResult.decisionLog` is populated with one
   * entry per retrieved fact: scoring breakdown, retrieval-stage
   * provenance, whether the synthesizer picked the fact for the answer,
   * and (for losers) a brief rejection reason.
   */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  explain?: boolean;

  /**
   * Locale-pinning (Phase 4.C). Pins the generator's answer to a
   * specific ISO 639-1 language. Citations remain in the language
   * of the underlying fact (per the FINOS air-governance pattern:
   * never silently translate a piece of evidence). When omitted the
   * generator answers in the dominant language of the input query.
   */
  @IsOptional()
  @IsString()
  answerLang?: string;
}
