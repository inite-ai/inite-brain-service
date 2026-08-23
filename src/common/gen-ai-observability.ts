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
        const usage = (res as OpenAiLikeResponse | undefined)?.usage;
        const responseId = (res as OpenAiLikeResponse | undefined)?.id;
        if (responseId) span.setAttribute('gen_ai.response.id', responseId);
        // For chat: prompt_tokens / completion_tokens. For embed
        // OpenAI returns total_tokens — fold it into prompt to keep the
        // labelled counter monotonically meaningful.
        const promptTokens =
          usage?.prompt_tokens ??
          (spec.kind === 'embed' ? usage?.total_tokens : undefined);
        const completionTokens = usage?.completion_tokens;
        if (typeof promptTokens === 'number') {
          span.setAttribute('gen_ai.usage.input_tokens', promptTokens);
        }
        if (typeof completionTokens === 'number') {
          span.setAttribute('gen_ai.usage.output_tokens', completionTokens);
        }
        metrics?.recordOpenAiCall({
          kind: spec.kind,
          outcome: 'ok',
          durationSeconds: elapsed,
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { completionTokens } : {}),
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
