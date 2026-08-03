import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Semaphore } from '../common/semaphore';
import { envFlagEnabled } from '../common/env-validation';
import { LocalCrossEncoderProvider } from './cross-encoder/local-cross-encoder.provider';

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
export class CrossEncoderService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(CrossEncoderService.name);
  private readonly enabled: boolean;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly limiter: Semaphore;
  private readonly localEnabled: boolean;
  private readonly localDeadlineMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly local?: LocalCrossEncoderProvider,
  ) {
    this.enabled =
      envFlagEnabled(
        this.configService.get<string>('SEARCH_CROSS_ENCODER_ENABLED'),
      );
    this.apiKey = this.configService.get<string>('COHERE_API_KEY');
    // Local fallback is opt-in and only matters when the primary (Cohere) path
    // isn't configured — a self-hoster with no rerank vendor.
    this.localEnabled = envFlagEnabled(
      this.configService.get<string>('SEARCH_CROSS_ENCODER_LOCAL'),
    );
    this.model = this.configService.get<string>(
      'SEARCH_CROSS_ENCODER_MODEL',
      'rerank-v3.5',
    );
    this.endpoint = this.configService.get<string>(
      'SEARCH_CROSS_ENCODER_ENDPOINT',
      'https://api.cohere.com/v2/rerank',
    );
    this.timeoutMs = parseInt(
      this.configService.get<string>('SEARCH_CROSS_ENCODER_TIMEOUT_MS', '5000'),
      10,
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('SEARCH_CROSS_ENCODER_CONCURRENCY', '4'),
        10,
      ),
    );
    // The local worker's scoring loop stops at this deadline so it never
    // outruns the rerank stage budget (whose withStageBudget wrapper would
    // otherwise drop the result while the worker kept burning CPU).
    this.localDeadlineMs = parseInt(
      this.configService.get<string>(
        'SEARCH_STAGE_BUDGET_CROSS_ENCODER_MS',
        '2000',
      ),
      10,
    );
  }

  /** Cohere (primary) path is configured. */
  private cohereConfigured(): boolean {
    return this.enabled && !!this.apiKey;
  }

  /** True when the LOCAL cross-encoder is the active path (no Cohere key).
   *  The caller uses a tighter candidate window for local inference. */
  isLocalOnly(): boolean {
    return !this.cohereConfigured() && this.localEnabled && !!this.local;
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
   *  True when EITHER the Cohere path is configured OR the local fallback is
   *  opted in and wired. */
  isEnabled(): boolean {
    return this.cohereConfigured() || (this.localEnabled && !!this.local);
  }

  /**
   * Re-rank `candidates` against `query`. Returns a permutation of
   * `[0..candidates.length)` in descending-relevance order. Identity
   * fallback on any failure — caller does not need to catch.
   */
  async rerank(
    query: string,
    candidates: CrossEncoderCandidate[],
  ): Promise<number[]> {
    const identity = candidates.map((_, i) => i);
    if (candidates.length <= 1 || !query.trim()) {
      return identity;
    }
    // Primary path is Cohere. When that isn't configured, fall back to the
    // local cross-encoder if opted in — a self-hoster with no rerank vendor
    // still gets a joint-encoder pass.
    if (!this.cohereConfigured()) {
      if (this.localEnabled && this.local) {
        return this.rerankLocal(query, candidates, identity);
      }
      return identity;
    }

    const documents = candidates.map((c) =>
      c.body ? `${c.label}\n${c.body}` : c.label,
    );

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
          body: JSON.stringify({
            model: this.model,
            query,
            documents,
            top_n: documents.length,
          }),
          signal: ac.signal,
        });
        if (!res.ok) {
          this.logger.warn(
            `Cross-encoder HTTP ${res.status} — falling back to identity`,
          );
          return identity;
        }
        const json = (await res.json()) as {
          results?: Array<{ index: number; relevance_score: number }>;
        };
        const results = json?.results;
        if (!Array.isArray(results) || results.length === 0) {
          return identity;
        }
        // Validate it's a permutation of [0..N). Cohere returns
        // exactly that, but defensive parsing keeps a malformed
        // response from poisoning the candidate set.
        const seen = new Set<number>();
        const out: number[] = [];
        for (const r of results) {
          if (typeof r?.index !== 'number' || !Number.isInteger(r.index)) {
            return identity;
          }
          if (r.index < 0 || r.index >= candidates.length) return identity;
          if (seen.has(r.index)) return identity;
          seen.add(r.index);
          out.push(r.index);
        }
        // Cohere returns ranked subset when fewer than top_n — fill
        // any missing indices in original order at the tail so the
        // result is always a full permutation.
        if (out.length < candidates.length) {
          for (let i = 0; i < candidates.length; i++) {
            if (!seen.has(i)) out.push(i);
          }
        }
        return out;
      });
    } catch (err) {
      const e = err as Error;
      this.logger.warn(
        `Cross-encoder ${e.name === 'AbortError' ? 'timed out' : 'failed'}: ${e.message}`,
      );
      return identity;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Local-model rerank branch. Scores each candidate with the local
   * cross-encoder and returns the descending-relevance permutation. Any failure
   * (warmup miss, mismatched score count) falls back to identity — retrieval
   * never breaks because the optional local reranker hiccupped, same contract
   * as the Cohere path.
   */
  private async rerankLocal(
    query: string,
    candidates: CrossEncoderCandidate[],
    identity: number[],
  ): Promise<number[]> {
    const documents = candidates.map((c) =>
      c.body ? `${c.label}\n${c.body}` : c.label,
    );
    try {
      const scores = await this.limiter.run(() =>
        this.local!.score(query, documents, this.localDeadlineMs),
      );
      if (scores.length !== candidates.length) return identity;
      // `|| 0` keeps the sort stable when two scores tie or are both
      // -Infinity (docs the deadline left unscored) — their difference is
      // NaN, which would otherwise make the comparator non-deterministic.
      return candidates
        .map((_, i) => i)
        .sort((a, b) => scores[b] - scores[a] || 0);
    } catch (e) {
      this.logger.warn(
        `Local cross-encoder failed: ${(e as Error).message} — falling back to identity`,
      );
      return identity;
    }
  }
}
