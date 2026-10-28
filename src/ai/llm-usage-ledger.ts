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
  /** The source file that made the call (see `callSite`). */
  site: string;
  calls: number;
  /** Calls that threw — a retry storm shows here before it shows on the bill. */
  errors: number;
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

export interface LlmCallAt {
  kind: 'chat' | 'embed';
  model: string;
  site?: string;
}

export function recordLlmUsage(at: LlmCallAt, usage: unknown): void {
  const { kind } = at;
  const row = rowFor(kind, at.model, at.site ?? 'unknown');
  const u = (usage ?? {}) as UsageLike;
  row.calls += 1;
  // Embeddings report `total_tokens`, and some providers send `prompt_tokens: 0`.
  row.inputTokens +=
    kind === 'embed' ? Math.max(num(u.prompt_tokens), num(u.total_tokens)) : num(u.prompt_tokens);
  row.cachedInputTokens += num(u.prompt_tokens_details?.cached_tokens);
  row.outputTokens += num(u.completion_tokens);
}

export function recordLlmError(at: LlmCallAt): void {
  rowFor(at.kind, at.model, at.site ?? 'unknown').errors += 1;
}

function rowFor(kind: 'chat' | 'embed', model: string, site: string): LlmUsageRow {
  const key = `${kind}\u0000${model}\u0000${site}`;
  let row = rows.get(key);
  if (!row) {
    row = {
      model,
      kind,
      site,
      calls: 0,
      errors: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    rows.set(key, row);
  }
  return row;
}

/** Frames that are plumbing between a caller and the SDK, never the caller. */
const PLUMBING = /(llm-usage-ledger|openai-client|gen-ai-observability|node_modules|node:internal)/;

/**
 * The first source file on the stack that is not plumbing, as its path
 * under `src/` without extension ("synthesize/verifier"). Taken
 * synchronously inside the patched `create`, so the caller's frame is
 * still there even when it awaits through `withGenAiCall`. File-level, not
 * line-level: the label set stays small (one per call-site file).
 */
export function callSite(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    if (PLUMBING.test(line)) continue;
    const m = /[/\\](?:src|dist)[/\\](.+?)\.(?:ts|js):\d+/.exec(line);
    if (m?.[1]) return m[1].replace(/\\/g, '/');
  }
  return 'unknown';
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
      const site = callSite(new Error().stack);
      const model = typeof body?.model === 'string' ? body.model : 'unknown';
      try {
        const res = await inner(body, opts);
        recordLlmUsage({ kind, model, site }, (res as { usage?: unknown } | undefined)?.usage);
        return res;
      } catch (err) {
        recordLlmError({ kind, model, site });
        throw err;
      }
    };
  };
  patch(target.chat.completions, 'chat');
  patch(target.embeddings, 'embed');
}
