/**
 * Every token this process spent on a model, by requested model id.
 *
 * `withGenAiCall` counts only the call sites wrapped in it — 16 of them on
 * 2026-10-28, while 9 more (scene enrichment, arcs, belief promotion,
 * aggregates, strategy distillation, agent QA, code capture) called the
 * SDK directly and spent tokens nobody saw. A flag measured on pass counts
 * alone then looks free when it is not, and one that halves the context
 * at the price of a point looks like a loss. This ledger sits on the SDK
 * client itself (`buildClient` in openai-client.ts), so a new call site is
 * counted without remembering to.
 *
 * Process-global on purpose: the client is built outside Nest's container,
 * and `/metrics` reads it through a collect-time gauge.
 */
export interface LlmUsageRow {
  model: string;
  kind: 'chat' | 'embed';
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const rows = new Map<string, LlmUsageRow>();

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export function recordLlmUsage(kind: 'chat' | 'embed', model: string, usage: unknown): void {
  const u = (usage ?? {}) as UsageLike;
  const key = `${kind}\u0000${model}`;
  const row = rows.get(key) ?? {
    model,
    kind,
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  row.calls += 1;
  // Embeddings report `total_tokens`, and some providers send `prompt_tokens: 0`.
  row.inputTokens +=
    kind === 'embed' ? Math.max(num(u.prompt_tokens), num(u.total_tokens)) : num(u.prompt_tokens);
  row.cachedInputTokens += num(u.prompt_tokens_details?.cached_tokens);
  row.outputTokens += num(u.completion_tokens);
  rows.set(key, row);
}

export function llmUsageSnapshot(): LlmUsageRow[] {
  return [...rows.values()].map((r) => ({ ...r }));
}

/** Test seam. */
export function resetLlmUsage(): void {
  rows.clear();
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
}

type Create = (body: { model?: unknown }, opts?: unknown) => Promise<unknown>;

/**
 * Patch a client's chat and embedding `create` so every response's usage
 * lands in the ledger. Applied last in `buildClient`, outside the provider
 * router, so a call the fallback served is counted under the model asked.
 * A stream has no usage on its return value and is counted as a call only.
 */
export function withUsageLedger(target: {
  chat: { completions: unknown };
  embeddings: unknown;
}): void {
  const patch = (holder: unknown, kind: 'chat' | 'embed') => {
    const h = holder as { create: Create };
    const inner = h.create.bind(holder);
    h.create = async (body, opts) => {
      const res = await inner(body, opts);
      const model = typeof body?.model === 'string' ? body.model : 'unknown';
      recordLlmUsage(kind, model, (res as { usage?: unknown } | undefined)?.usage);
      return res;
    };
  };
  patch(target.chat.completions, 'chat');
  patch(target.embeddings, 'embed');
}
