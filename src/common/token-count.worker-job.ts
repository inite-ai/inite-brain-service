/**
 * JobWorkerPool handler — batch tiktoken counting for search
 * `tokenBudget` shaping.
 *
 * Contract: `run({ texts: string[] })` → `{ counts: number[] }` where
 * `counts[i]` is the exact cl100k_base token count of `texts[i]`. The
 * caller (response-builder) serialises each hit with JSON.stringify on
 * the main thread and ships the strings here, so `countTokens(text)`
 * is bit-identical to the in-thread `countJsonTokens(hit)` fallback —
 * same string, same cached encoder.
 *
 * The first call in a fresh worker pays the one-time encoder build;
 * the runner's module cache (and token-counter's own encoder cache)
 * keeps it resident for every call after that.
 *
 * Module resolution: a plain relative import fails at runtime here —
 * under Node 24 native type-stripping this file executes as ESM inside
 * the pool worker (no extension search, and `__dirname` is undefined),
 * while after `nest build` it runs as compiled CJS. So resolve the
 * sibling module dynamically: try the built `.js` first (dist), then
 * fall back to the runtime-assembled `.ts` (dev / ts-jest); the
 * template-literal specifiers keep tsc from trying to statically
 * resolve either candidate.
 */
interface TokenCounterModule {
  countTokens: (text: string) => number;
}

let counterModule: Promise<TokenCounterModule> | null = null;

function loadCounter(): Promise<TokenCounterModule> {
  if (!counterModule) {
    const base = './token-counter';
    counterModule = (import(`${base}.js`) as Promise<TokenCounterModule>).catch(
      () => import(`${base}.ts`) as Promise<TokenCounterModule>,
    );
  }
  return counterModule;
}

export async function run(input: unknown): Promise<{ counts: number[] }> {
  const texts = (input as { texts?: unknown }).texts;
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) {
    throw new Error('token-count worker expects { texts: string[] }');
  }
  const { countTokens } = await loadCounter();
  return { counts: (texts as string[]).map((t) => countTokens(t)) };
}
