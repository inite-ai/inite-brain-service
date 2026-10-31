import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Semaphore } from '../common/semaphore';
import { LocalCrossEncoderProvider } from './cross-encoder/local-cross-encoder.provider';
import { serverModelsRefused } from '../common/extraction-source';

/**
 * Cross-encoder reranker via Cohere Rerank v3.5.
 *
 * Sits BETWEEN convex-fusion and the LLM listwise reranker. The
 * fusion stage produces a wide candidate window (default 50) sorted
 * by hybrid score; the cross-encoder reorders that window with a
 * proper joint-encoder model (query × document attention, not pooled
 * embeddings) and yields a tighter top-K (default 20) which the LLM
 * reranker — if enabled — refines further.
 *
 * Why a cross-encoder before the LLM:
 *   1. The cross-encoder gives token-overlap fuzziness that pooled
 *      embeddings miss without paying an LLM round-trip.
 *   2. It pre-prunes the LLM's input window, so the LLM sees a
 *      higher-precision candidate set and the rerank prompt stays
 *      small (latency / cost).
 *   3. Combined with SEARCH_RERANK_SKIP_MARGIN, many queries end up
 *      not needing the LLM at all — cross-encoder lift was enough.
 *
 * API: Cohere Rerank v2 endpoint, REST. Direct fetch — Cohere's
 * official SDK pulls axios + transitive deps; one POST and a JSON
 * response don't earn that bundle. AbortController governs timeout
 * (default 5s); the `OPENAI_TIMEOUT_MS` env shape is reused for
 * symmetry but we're talking to Cohere here.
 *
 * Failure mode: any non-2xx, network error, timeout, or malformed
 * response returns the identity permutation. Retrieval never breaks
 * because the optional cross-encoder hiccupped — same contract as
 * the LLM reranker.
 */
export interface CrossEncoderCandidate {
  /** Compact label for the candidate (e.g. canonical name + type). */
  label: string;
  /** Body — best 2-3 facts per candidate, kept short. */
  body: string;
}

@Injectable()
export class CrossEncoderService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CrossEncoderService.name);
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly limiter: Semaphore;
  private readonly localDeadlineMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly local?: LocalCrossEncoderProvider,
  ) {
    // Capability, not a flag: the Cohere path engages when a vendor key
    // is present; otherwise the local worker (no vendor key, deadline-
    // bounded, its own thread) serves — cross-encoder reranking is the
    // single biggest measured lever in the field (SmartSearch reaches
    // 88.4 on LongMemEval with verbatim passages + a local reranker and
    // no graph — docs/roadmap/lme-sota-research-2026-08.md §1/§4).
    this.apiKey = this.configService.get<string>('COHERE_API_KEY');
    this.model = this.configService.get<string>('SEARCH_CROSS_ENCODER_MODEL', 'rerank-v3.5');
    this.endpoint = this.configService.get<string>(
      'SEARCH_CROSS_ENCODER_ENDPOINT',
      'https://api.cohere.com/v2/rerank',
    );
    this.timeoutMs = parseInt(
      this.configService.get<string>('SEARCH_CROSS_ENCODER_TIMEOUT_MS', '5000'),
      10,
    );
    this.limiter = new Semaphore(
      parseInt(this.configService.get<string>('SEARCH_CROSS_ENCODER_CONCURRENCY', '4'), 10),
    );
    // The local worker's scoring loop stops at this deadline so it never
    // outruns the rerank stage budget (whose withStageBudget wrapper would
    // otherwise drop the result while the worker kept burning CPU).
    this.localDeadlineMs = parseInt(
      this.configService.get<string>('SEARCH_STAGE_BUDGET_CROSS_ENCODER_MS', '2000'),
      10,
    );
  }

  /** Cohere (primary) path is configured. */
  private cohereConfigured(): boolean {
    // Harness mode buys no vendor rerank; the local worker serves.
    return !!this.apiKey && !serverModelsRefused();
  }

  /** True when the LOCAL cross-encoder is the active path (no Cohere key).
   *  The caller uses a tighter candidate window for local inference. */
  isLocalOnly(): boolean {
    return !this.cohereConfigured() && !!this.local;
  }

  /** Best-effort boot warmup so the ~279MB model download isn't paid in the
   *  first query's request path. No-op unless the local path is active. */
  async warmupLocal(): Promise<void> {
    if (this.isLocalOnly() && this.local) {
      await this.local.warmup().catch(() => undefined);
    }
  }

  onApplicationBootstrap(): void {
    // Fire-and-forget: warm the model in the worker so it's ready before the
    // first query, without blocking boot. No-op unless the local path is on.
    void this.warmupLocal();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.local?.terminate().catch(() => undefined);
  }

  /** Whether the rerank stage should run at all — the caller gates on this.
   *  True when EITHER the Cohere path is configured OR the local provider
   *  is wired. */
  isEnabled(): boolean {
    return this.cohereConfigured() || !!this.local;
  }

  /**
   * Re-rank `candidates` against `query`. Returns a permutation of
   * `[0..candidates.length)` in descending-relevance order. Identity
   * fallback on any failure — caller does not need to catch.
   */
  async rerank(query: string, candidates: CrossEncoderCandidate[]): Promise<number[]> {
    const identity = candidates.map((_, i) => i);
    const scores = await this.relevance(query, candidates);
    if (scores.every((v) => v === undefined)) return identity;
    // Unscored candidates (a deadline stopped the local loop) keep their
    // input order below every scored one; `|| a - b` keeps ties stable.
    const key = (i: number) => scores[i] ?? Number.NEGATIVE_INFINITY;
    return identity.sort((a, b) => key(b) - key(a) || a - b);
  }

  /**
   * The cross-encoder's relevance of each candidate to `query` as a
   * probability in [0, 1], in input order; `undefined` where it was not
   * scored (failure, timeout, a deadline). The rerank stage used to
   * reduce this to a permutation and throw it away, which left the read
   * path with no calibrated, query-specific relevance at all — only a
   * fused score (0.5 × cosine when BM25 is silent). Cohere returns a
   * relevance_score; the local bge-reranker returns a logit, mapped
   * through the sigmoid as its authors do (FlagEmbedding `normalize`).
   */
  async relevance(
    query: string,
    candidates: CrossEncoderCandidate[],
  ): Promise<Array<number | undefined>> {
    const none = candidates.map((): number | undefined => undefined);
    if (candidates.length === 0 || !query.trim()) return none;
    const documents = candidates.map((c) => (c.body ? `${c.label}\n${c.body}` : c.label));
    if (!this.cohereConfigured()) {
      return this.local ? this.relevanceLocal(query, documents, none) : none;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs).unref();
    try {
      return await this.limiter.run(async () => {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ model: this.model, query, documents, top_n: documents.length }),
          signal: ac.signal,
        });
        if (!res.ok) {
          this.logger.warn(`Cross-encoder HTTP ${res.status} — no relevance this time`);
          return none;
        }
        const json = (await res.json()) as {
          results?: Array<{ index: number; relevance_score: number }>;
        };
        // Defensive: a malformed entry is skipped, never trusted.
        const out = [...none];
        for (const r of json?.results ?? []) {
          if (!Number.isInteger(r?.index) || r.index < 0 || r.index >= out.length) continue;
          if (typeof r.relevance_score === 'number' && Number.isFinite(r.relevance_score)) {
            out[r.index] = r.relevance_score;
          }
        }
        return out;
      });
    } catch (err) {
      const e = err as Error;
      this.logger.warn(
        `Cross-encoder ${e.name === 'AbortError' ? 'timed out' : 'failed'}: ${e.message}`,
      );
      return none;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Local-model branch. Any failure (warmup miss, mismatched score count)
   * yields no relevance — retrieval never breaks because the optional
   * local reranker hiccupped, same contract as the Cohere path.
   */
  private async relevanceLocal(
    query: string,
    documents: string[],
    none: Array<number | undefined>,
  ): Promise<Array<number | undefined>> {
    // The deadline is absolute and taken BEFORE the limiter: time spent
    // waiting for a slot is time the caller's stage budget is already
    // spending, and the provider's loop must stop inside that budget,
    // not inside a fresh one that starts when the slot frees.
    const deadlineAt = Date.now() + this.localDeadlineMs;
    try {
      const logits = await this.limiter.run(() => this.local!.score(query, documents, deadlineAt));
      if (logits.length !== documents.length) return none;
      return logits.map((v) => (Number.isFinite(v) ? 1 / (1 + Math.exp(-v)) : undefined));
    } catch (e) {
      this.logger.warn(`Local cross-encoder failed: ${(e as Error).message} — no relevance`);
      return none;
    }
  }
}
