import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

/**
 * The chat model every LLM call runs on unless OPENAI_CHAT_MODEL says
 * otherwise: the cost tier of the newest generation (gpt-5.6-luna, July
 * 2026 — $0.20 / $1.20 per 1M, structured outputs, reasoning effort
 * selectable, `temperature` rejected). It replaced gpt-4o-mini, which
 * flip-flopped on identical entity pairs between runs and mis-cited
 * twelve-line evidence sets. One constant: twenty-two readers used to
 * carry their own `'gpt-4o-mini'` fallback.
 */
export const DEFAULT_CHAT_MODEL = 'gpt-5.6-luna';

/** OPENAI_CHAT_MODEL, else the platform default. */
export function chatModel(config: ConfigService): string {
  return config.get<string>('OPENAI_CHAT_MODEL', DEFAULT_CHAT_MODEL);
}

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

/**
 * The effort levels a reasoning model accepts on chat completions
 * (gpt-5.6 rejects `minimal` — probed 2026-09-17).
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * What a reasoning model gets when the caller does not say: the model's
 * own default is `medium`, which for an extraction or a grounded answer
 * bills hidden reasoning many times the visible output. `low` keeps the
 * short deliberation (25 reasoning tokens on a two-fact extraction) at
 * a fraction of the cost; one-token classifiers ask for `none`.
 */
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

export function chatCallParams(
  model: string,
  opts: {
    temperature: number;
    visibleCap: number;
    reasoningCap?: number;
    /**
     * How much a reasoning model may think before answering. Emitted
     * ONLY on the reasoning branch — a deterministic model rejects the
     * field. Unset = DEFAULT_REASONING_EFFORT; a judge or classifier
     * whose answer is one token asks for `none`.
     */
    reasoningEffort?: ReasoningEffort;
  },
): { temperature?: number; max_completion_tokens: number; reasoning_effort?: ReasoningEffort } {
  return isReasoningModel(model)
    ? {
        max_completion_tokens: opts.reasoningCap ?? opts.visibleCap * 4,
        reasoning_effort: opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      }
    : { temperature: opts.temperature, max_completion_tokens: opts.visibleCap };
}
