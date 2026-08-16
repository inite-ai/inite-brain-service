import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

function buildClient(config: ConfigService, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    timeout: parseInt(config.get<string>('OPENAI_TIMEOUT_MS', '30000'), 10),
    maxRetries: parseInt(config.get<string>('OPENAI_MAX_RETRIES', '3'), 10),
  });
}

/**
 * The one way to construct an OpenAI SDK client. Every service used to
 * hand-roll `new OpenAI({...})` with its own copy of the
 * OPENAI_TIMEOUT_MS / OPENAI_MAX_RETRIES parsing — 13 copies meant an
 * operator knob change had 13 chances to miss one. Returns null when
 * OPENAI_API_KEY is unset so feature-gated callers can treat "no key"
 * as feature-off; callers that REQUIRE the key use the orThrow variant.
 */
export function createOpenAiClient(config: ConfigService): OpenAI | null {
  const apiKey = config.get<string>('OPENAI_API_KEY');
  if (!apiKey) return null;
  return buildClient(config, apiKey);
}

/**
 * Required-key variant. Reads via `getOrThrow` so a missing key throws
 * Nest's canonical configuration error at construction time — the exact
 * behaviour the non-gated services (extractor, synthesize, embedder,
 * chat router, multi-hop planner) had before the consolidation.
 */
export function createOpenAiClientOrThrow(config: ConfigService): OpenAI {
  return buildClient(config, config.getOrThrow<string>('OPENAI_API_KEY'));
}

/**
 * Per-model-class chat-call params — the ONE copy of the reasoning
 * guard (the measured V11 §2 class: gpt-5 and o-series models reject a
 * non-default temperature with 400 and bill hidden reasoning against
 * max_completion_tokens, so tight caps starve the visible output).
 * Verifier, generator and deriver all hand-rolled this after the
 * verifier fix; three copies with divergent cap policies is exactly
 * the 13-client lesson above repeating itself.
 *
 * `gpt-5-chat*` variants are NOT reasoning models (they accept
 * temperature) — the negative lookahead keeps them on the
 * deterministic branch, where an over-match would silently run
 * temperature-1.0 replicates through a ±few-pp measurement program.
 */
const REASONING_MODEL_RE = /^(gpt-5(?!-chat)|o\d)/;

export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_RE.test(model);
}

export function chatCallParams(
  model: string,
  opts: { temperature: number; visibleCap: number; reasoningCap?: number },
): { temperature?: number; max_completion_tokens: number } {
  return isReasoningModel(model)
    ? { max_completion_tokens: opts.reasoningCap ?? opts.visibleCap * 4 }
    : { temperature: opts.temperature, max_completion_tokens: opts.visibleCap };
}
