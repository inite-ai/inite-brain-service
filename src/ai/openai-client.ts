import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

/**
 * The chat model every LLM call runs on unless OPENAI_CHAT_MODEL says
 * otherwise: the cost tier of the newest generation (gpt-6-luna — $0.10 /
 * $0.50 per 1M, structured outputs, reasoning effort selectable,
 * `temperature` rejected). It replaced gpt-5.6-luna on 2026-09-24, measured
 * on the prod-parity stand:
 *
 *   arm                                   memory-fitness   state-transitions (ru)
 *   gpt-5.6-luna                          31/32            10/12 · 23/25
 *   gpt-6-luna everywhere                 30/32            11/12 · 24/25
 *   gpt-6-luna + verifier on gpt-5.6      32/32            11/12 · 24/25
 *
 * The middle row is why the verifier keeps the older model
 * (RETRIEVAL_VERIFIER_MODEL): gpt-6-luna spends reasoning tokens at `low`
 * effort where gpt-5.6-luna spends none, and audits the same evidence more
 * strictly — both of its memory-fitness losses were abstentions on answers
 * the evidence did support. Everywhere else the newer model is at least as
 * good at half the input price and 2.4× less per output token.
 *
 * Before it: gpt-4o-mini, which flip-flopped on identical entity pairs
 * between runs and mis-cited twelve-line evidence sets. One constant:
 * twenty-two readers used to carry their own `'gpt-4o-mini'` fallback.
 */
export const DEFAULT_CHAT_MODEL = 'gpt-6-luna';

/**
 * What the verifier runs on when nothing overrides it. Its own default
 * because the audit is the one call where the newer model measured WORSE —
 * see the table above. RETRIEVAL_VERIFIER_MODEL still wins when set.
 */
export const DEFAULT_VERIFIER_MODEL = 'gpt-5.6-luna';

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
 *
 * The range covers the generation AFTER gpt-5 as well: probed against the
 * live API on 2026-09-23, `gpt-6-luna` and `gpt-6-sol` reject
 * `temperature: 0` with the same 400 ("Only the default (1) value is
 * supported") and accept `reasoning_effort` none|low|medium|high|xhigh —
 * the docs' `max` is rejected on chat completions. A generation the guard
 * does not recognise takes the deterministic branch and 400s on every
 * call, so the class, not the exact version, is what it matches.
 */
const REASONING_MODEL_RE = /^(gpt-[5-9](?!-chat)|o\d)/;

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

/**
 * The processing tier a call asks for. `flex` is the SAME model at the Batch
 * price — half — in exchange for slower service and a 429 when capacity is
 * short (the request is not charged when that happens). `auto` falls back to
 * standard on a retry. Probed 2026-09-23: gpt-5.6-luna, gpt-6-luna and
 * gpt-6-sol all accept it and answer `service_tier: "flex"`.
 */
export type ServiceTier = 'flex' | 'auto';

/**
 * The tier for work nobody is waiting on — scene building, belief promotion,
 * the dream jobs, the composers, code indexing. `OPENAI_OFFLINE_SERVICE_TIER`
 * names it once rather than each cron picking its own; unset means the
 * standard tier and a byte-identical request. A lane on the REQUEST path never
 * asks for it: there, latency is the product.
 */
export function offlineServiceTier(): ServiceTier | undefined {
  const raw = (process.env.OPENAI_OFFLINE_SERVICE_TIER ?? '').trim();
  return raw === 'flex' || raw === 'auto' ? raw : undefined;
}

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
    reasoningEffort?: ReasoningEffort | undefined;
    /**
     * Ask for a non-standard processing tier. Only for calls no user is
     * waiting on — see `offlineServiceTier`.
     */
    tier?: ServiceTier | undefined;
  },
): {
  temperature?: number;
  max_completion_tokens: number;
  reasoning_effort?: ReasoningEffort;
  service_tier?: ServiceTier;
} {
  const tier = opts.tier === undefined ? {} : { service_tier: opts.tier };
  return isReasoningModel(model)
    ? {
        ...tier,
        max_completion_tokens: opts.reasoningCap ?? opts.visibleCap * 4,
        reasoning_effort: opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      }
    : { ...tier, temperature: opts.temperature, max_completion_tokens: opts.visibleCap };
}
