/**
 * Single instrumentation wrapper for every LLM call in the service.
 *
 * Closes two audit gaps at once:
 *
 *   1. **OTel GenAI SemConv 2025 compliance** — pre-fix, `grep gen_ai.`
 *      across src/ returned zero hits. The wrapper attaches the
 *      standard `gen_ai.system`, `gen_ai.request.model`,
 *      `gen_ai.response.id`, `gen_ai.usage.input_tokens`,
 *      `gen_ai.usage.output_tokens` attributes on the span so any
 *      conformant LLM observability backend (Langfuse, Phoenix,
 *      Honeycomb, Grafana Tempo) lights up.
 *
 *   2. **MetricsService.recordOpenAiCall wiring** — the method was
 *      defined but never called. The wrapper records duration +
 *      success/error outcome + prompt/completion token counts off
 *      the same response, so the `brain_openai_calls_total`,
 *      `brain_openai_tokens_total`, and `brain_openai_call_duration_seconds`
 *      metrics finally surface in /metrics.
 *
 * Designed to slot in around an existing OpenAI SDK call with
 * minimal diff at the call site — wrap the LLM call, return its
 * result unchanged.
 */
import type { MetricsService } from '../metrics/metrics.service';
import { withSpan } from './tracing';

export type GenAiKind = 'chat' | 'embed';

interface OpenAiLikeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  // Embeddings endpoint reports total_tokens only.
  total_tokens?: number;
  /**
   * How much of the prompt was served from the provider's prefix cache.
   * Chat completions report it here; the responses API names the same number
   * `input_tokens_details`. Cached input bills at a tenth of the rate, so a
   * call plane that does not count it cannot tell an expensive prompt from a
   * free one — and every prefix-stability change becomes unmeasurable.
   */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  /**
   * What the call actually cost, when the gateway reports it (OpenRouter does,
   * on both chat completions and the decisions endpoint). Recorded as a span
   * attribute rather than a metric: it is money per call, not a rate, and the
   * per-model arithmetic that would otherwise reconstruct it drifts the moment
   * a price changes.
   */
  cost?: number;
}

interface OpenAiLikeResponse {
  id?: string;
  usage?: OpenAiLikeUsage;
}

export interface GenAiCallSpec {
  kind: GenAiKind;
  // span name — e.g. 'gen_ai.chat.extractor' or 'gen_ai.embed.bge-m3'.
  spanName: string;
  // gen_ai.system — 'openai' for the OpenAI API, 'cohere' for Cohere
  // rerank, 'huggingface' for local Xenova/transformers, etc.
  system: string;
  // gen_ai.request.model.
  model: string;
  // Extra attributes to attach (e.g. tenant scope, leg). Avoid raw user
  // text or fact contents — those are debug-trace concerns, not OTel.
  attrs?: Record<string, string | number | boolean>;
}

/**
 * The usage numbers worth keeping off one response, in both the shape the
 * metric wants and the span attributes. Split out of the wrapper because the
 * shapes multiplied: chat vs embed naming, the two cached-token spellings, and
 * a gateway-reported cost.
 */
function readUsage(
  res: unknown,
  kind: GenAiKind,
): {
  tokens: { promptTokens?: number; completionTokens?: number; cachedPromptTokens?: number };
  attrs: Record<string, number>;
} {
  const usage = (res as OpenAiLikeResponse | undefined)?.usage;
  // For chat: prompt_tokens / completion_tokens. For embed OpenAI returns
  // total_tokens — fold it into prompt to keep the labelled counter
  // monotonically meaningful.
  const promptTokens = usage?.prompt_tokens ?? (kind === 'embed' ? usage?.total_tokens : undefined);
  const completionTokens = usage?.completion_tokens;
  const details = usage?.prompt_tokens_details ?? usage?.input_tokens_details;
  const cachedPromptTokens = details?.cached_tokens;
  const attrs: Record<string, number> = {};
  if (typeof promptTokens === 'number') attrs['gen_ai.usage.input_tokens'] = promptTokens;
  if (typeof completionTokens === 'number') attrs['gen_ai.usage.output_tokens'] = completionTokens;
  if (typeof cachedPromptTokens === 'number') {
    attrs['gen_ai.usage.cached_input_tokens'] = cachedPromptTokens;
  }
  if (typeof usage?.cost === 'number') attrs['gen_ai.usage.cost'] = usage.cost;
  return {
    tokens: {
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    },
    attrs,
  };
}

/**
 * Wrap an LLM call. Returns whatever the inner fn returns. Errors
 * propagate untouched after the metric + span ERROR status is set.
 */
export async function withGenAiCall<R extends OpenAiLikeResponse | unknown>(
  spec: GenAiCallSpec,
  metrics: MetricsService | undefined,
  fn: () => Promise<R>,
): Promise<R> {
  const startedAt = Date.now();
  return withSpan(
    spec.spanName,
    async (span) => {
      span.setAttribute('gen_ai.system', spec.system);
      span.setAttribute('gen_ai.request.model', spec.model);
      span.setAttribute('gen_ai.operation.name', spec.kind);
      if (spec.attrs) {
        for (const [k, v] of Object.entries(spec.attrs)) {
          span.setAttribute(k, v);
        }
      }
      try {
        const res = await fn();
        const elapsed = (Date.now() - startedAt) / 1000;
        const counted = readUsage(res, spec.kind);
        const responseId = (res as OpenAiLikeResponse | undefined)?.id;
        if (responseId) span.setAttribute('gen_ai.response.id', responseId);
        for (const [attr, value] of Object.entries(counted.attrs)) {
          span.setAttribute(attr, value);
        }
        metrics?.recordOpenAiCall({
          kind: spec.kind,
          outcome: 'ok',
          durationSeconds: elapsed,
          ...counted.tokens,
        });
        return res;
      } catch (err) {
        const elapsed = (Date.now() - startedAt) / 1000;
        metrics?.recordOpenAiCall({
          kind: spec.kind,
          outcome: 'error',
          durationSeconds: elapsed,
        });
        throw err;
      }
    },
    spec.attrs,
  );
}
