/**
 * Per-stage soft budgets for the optional LLM legs of the search
 * pipeline. A stage that exceeds its budget fails open with the
 * provided fallback (typically the upstream stage's result), so a
 * stalled OpenAI / Cohere / SurrealDB call cannot stack 30s × N
 * tail latency on a /v1/search request.
 *
 * Budgets are tunable via env (SEARCH_STAGE_BUDGET_*_MS) without
 * a code change; the constants below are the defaults the deploy
 * workflow encodes. Numbers are derived from p50 stage latency on
 * the eval — a 4s reranker budget covers SC=3 parallel calls at
 * ~700ms each plus headroom; 2s router budget covers a cached miss
 * with one round trip; 2s backfill budget covers the inline subquery
 * on a few-thousand-fact tenant.
 */
export const DEFAULT_STAGE_BUDGET_MS = {
  router: 2000,
  rerank: 4000,
  crossEncoder: 2000,
  backfill: 2000,
} as const;

export type StageBudgets = Record<keyof typeof DEFAULT_STAGE_BUDGET_MS, number>;

export function resolveStageBudgets(env = process.env): StageBudgets {
  const fromEnv = (key: string, fallback: number): number => {
    const raw = env[key];
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    router: fromEnv('SEARCH_STAGE_BUDGET_ROUTER_MS', DEFAULT_STAGE_BUDGET_MS.router),
    rerank: fromEnv('SEARCH_STAGE_BUDGET_RERANK_MS', DEFAULT_STAGE_BUDGET_MS.rerank),
    crossEncoder: fromEnv(
      'SEARCH_STAGE_BUDGET_CROSS_ENCODER_MS',
      DEFAULT_STAGE_BUDGET_MS.crossEncoder,
    ),
    backfill: fromEnv(
      'SEARCH_STAGE_BUDGET_BACKFILL_MS',
      DEFAULT_STAGE_BUDGET_MS.backfill,
    ),
  };
}

/**
 * Race a promise against a per-stage deadline; on timeout return the
 * fallback and log a warning. Pure helper — no metric coupling so it
 * stays mockable. Caller is responsible for wiring metrics if it
 * cares about per-stage timeout counts.
 *
 * The original promise keeps running in the background after timeout
 * (we cannot synchronously cancel an arbitrary Promise) — that is
 * fine, the result is dropped on the floor. Memory pressure is bounded
 * by OPENAI_CONCURRENCY / per-stage limiters upstream.
 */
export async function withStageBudget<T>(
  stage: keyof typeof DEFAULT_STAGE_BUDGET_MS,
  budgetMs: number,
  fn: () => Promise<T>,
  fallback: T,
  logger?: { warn: (msg: string) => void },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ __timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), budgetMs);
  });
  try {
    const winner = await Promise.race([fn().then((v) => ({ ok: v })), timeout]);
    if ('__timedOut' in winner) {
      logger?.warn(
        `Search stage '${stage}' exceeded ${budgetMs}ms budget — falling back`,
      );
      return fallback;
    }
    return winner.ok;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
