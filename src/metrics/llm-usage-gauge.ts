import { Gauge, type Registry } from 'prom-client';
import { llmUsageSnapshot } from '../ai/llm-usage-ledger';

/**
 * Cumulative tokens by requested model, read at scrape time from the
 * SDK-level ledger (src/ai/llm-usage-ledger.ts), which sees every call —
 * `brain_openai_tokens_total` sees only the sites wrapped in
 * `withGenAiCall`. Batteries diff two scrapes to price an arm.
 */
export function llmUsageGauge(registry: Registry): Gauge<'kind' | 'model' | 'site' | 'type'> {
  return new Gauge({
    name: 'brain_llm_tokens',
    help: 'Tokens spent on models since boot, by kind, requested model, calling source file and token type (every SDK call)',
    labelNames: ['kind', 'model', 'site', 'type'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const r of llmUsageSnapshot()) {
        const l = { kind: r.kind, model: r.model, site: r.site };
        this.set({ ...l, type: 'calls' }, r.calls);
        this.set({ ...l, type: 'errors' }, r.errors);
        this.set({ ...l, type: 'input' }, r.inputTokens);
        this.set({ ...l, type: 'cached_input' }, r.cachedInputTokens);
        this.set({ ...l, type: 'output' }, r.outputTokens);
      }
    },
  });
}
