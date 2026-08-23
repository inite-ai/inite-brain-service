import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClient } from './openai-client';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';
import { getAbortSignal } from '../common/request-context';
import { MetricsService } from '../metrics/metrics.service';

export interface RerankCandidate {
  /** A short label identifying the candidate (e.g. canonical name). */
  label: string;
  /** A few-line summary of the candidate's facts to score against. */
  body: string;
}

/**
 * Listwise re-ranker. Takes a query and an ordered list of fused
 * candidates and returns a permutation of indices in descending
 * relevance order. RankGPT-style prompt — joint scoring of
 * (query, candidate) lets the model encode IS-A and predicate-class
 * semantics that pooled embeddings miss.
 *
 * Permutation Self-Consistency (Tang et al., NAACL 2024):
 * SEARCH_RERANKER_SC_N controls the number of parallel calls.
 * When >1, each call sees the candidates in a different shuffled
 * order; we aggregate the rankings via Borda count. Marginalises
 * out positional bias and run-to-run jitter at the cost of N×
 * tokens (latency stays roughly constant — the calls fire in
 * parallel through the limiter).
 *
 * A capability, not a flag: reranking runs whenever the OpenAI client
 * is configured. On any failure (timeout, malformed output, partial
 * permutation) we return the original order so retrieval never
 * breaks because of the optional reranker.
 */
@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly limiter: Semaphore;
  private readonly scN: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.openai = createOpenAiClient(this.configService) ?? (undefined as unknown as OpenAI);
    this.model = this.configService.get<string>(
      'SEARCH_RERANKER_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(this.configService.get<string>('SEARCH_RERANKER_CONCURRENCY', '4'), 10),
    );
    // SC_N: number of parallel rerank calls used for permutation
    // self-consistency. 1 = no SC (single call). 3-5 are common
    // in the literature; 3 is the standard default for cost.
    const rawN = parseInt(this.configService.get<string>('SEARCH_RERANKER_SC_N', '1'), 10);
    this.scN = Number.isFinite(rawN) && rawN > 0 ? rawN : 1;
  }

  isEnabled(): boolean {
    return !!this.openai;
  }

  /**
   * Re-rank the candidates against the query. Returns a permutation
   * of `[0..candidates.length)` in descending-relevance order.
   *
   * SC mode (scN > 1): runs scN calls in parallel, each with a
   * different shuffled candidate order, aggregates via Borda count.
   * Falls back to identity on any catastrophic failure.
   *
   * Skip when ≤1 candidate or query is empty.
   */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<number[]> {
    const identity = candidates.map((_, i) => i);
    if (!this.isEnabled() || candidates.length <= 1 || !query.trim()) {
      return identity;
    }

    if (this.scN === 1) {
      // Single-call path. Identity ordering — no shuffle.
      return this.singleRerank({ query, candidates, presentationOrder: identity });
    }

    // Permutation self-consistency: run scN calls in parallel with
    // different shuffled orderings and aggregate via Borda count.
    // Each call sees a unique shuffle of [0..N); the call returns a
    // permutation in the SHUFFLED space, which singleRerank then
    // maps back to parent indices before returning.
    const orderings = Array.from({ length: this.scN }, () => shuffle(candidates.map((_, i) => i)));
    const settled = await Promise.allSettled(
      orderings.map((ord) => this.singleRerank({ query, candidates, presentationOrder: ord })),
    );
    const rankings: number[][] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value.length === candidates.length) {
        rankings.push(s.value);
      }
    }
    if (rankings.length === 0) return identity;
    if (rankings.length === 1) return rankings[0]!;
    return bordaAggregate(rankings, candidates.length);
  }

  /**
   * Single rerank call. `presentationOrder` defines the order in
   * which candidates are listed in the prompt — typically identity
   * for non-SC mode, or a random permutation for SC. The returned
   * array is in PARENT index space (i.e. mapped back through
   * presentationOrder), so callers don't have to know about the
   * shuffle.
   */
  private async singleRerank({
    query,
    candidates,
    presentationOrder,
  }: {
    query: string;
    candidates: RerankCandidate[];
    presentationOrder: number[];
  }): Promise<number[]> {
    const identity = candidates.map((_, i) => i);
    const items = presentationOrder
      .map((parentIdx, presIdx) => {
        const c = candidates[parentIdx];
        if (!c) return `[${presIdx}] `; // out-of-range presentation index
        return `[${presIdx}] ${c.label}\n${c.body}`;
      })
      .join('\n\n');
    const systemPrompt = `You are a relevance ranker for a knowledge-graph search system. Given a user query and a list of candidate entities (each with a label and a short summary of facts and connections), reorder the candidates from MOST to LEAST relevant to the query.

Use the literal text of the facts; don't invent missing context. Prefer candidates whose facts directly answer the query (object terms, predicate semantics, IS-A reasoning). When the query mentions an event / project / place, prefer the actor (person/customer/staff) who participated, not the event/project entity itself, unless the query explicitly asks for the entity. When two candidates are similarly relevant, favour the one with more directly-supporting evidence.

Return ONLY a JSON object of the shape {"ranking": [<index>, ...]} listing every candidate index from the input exactly once, in the new order.`;
    const userPrompt = `Query: ${query}\n\nCandidates:\n${items}`;

    try {
      const res = await this.limiter.run(() =>
        withGenAiCall(
          {
            kind: 'chat',
            spanName: 'gen_ai.chat.reranker',
            system: 'openai',
            model: this.model,
            attrs: { 'brain.rerank.candidates': candidates.length },
          },
          this.metrics,
          () =>
            this.openai.chat.completions.create(
              {
                model: this.model,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt },
                ],
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: 'reranking',
                    strict: true,
                    schema: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        ranking: {
                          type: 'array',
                          items: { type: 'integer', minimum: 0 },
                        },
                      },
                      required: ['ranking'],
                    },
                  },
                },
                max_completion_tokens: 256,
                temperature: 0,
              },
              { signal: getAbortSignal() },
            ),
        ),
      );

      const content = res.choices[0]?.message?.content;
      if (!content) return identity;
      const parsed = JSON.parse(content);
      const presentationRanking: unknown = parsed?.ranking;
      if (!Array.isArray(presentationRanking)) return identity;

      // Validate: must be a permutation of [0..N) in PRESENTATION
      // index space. Map each entry back through presentationOrder
      // to get the parent index.
      const seen = new Set<number>();
      const validatedParentIdx: number[] = [];
      for (const x of presentationRanking) {
        if (typeof x !== 'number' || !Number.isInteger(x)) return identity;
        if (x < 0 || x >= candidates.length) return identity;
        if (seen.has(x)) return identity;
        seen.add(x);
        // x ∈ [0, candidates.length) = presentationOrder.length ⇒ in-bounds.
        validatedParentIdx.push(presentationOrder[x]!);
      }
      if (validatedParentIdx.length !== candidates.length) return identity;
      return validatedParentIdx;
    } catch (err) {
      this.logger.warn(`Reranker failed, falling back: ${(err as Error).message}`);
      return identity;
    }
  }
}

/**
 * Fisher-Yates in-place shuffle. Math.random is fine for the
 * positional-bias marginalisation; we don't need cryptographic
 * randomness here.
 */
function shuffle<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // i ∈ [1, len-1], j ∈ [0, i] ⇒ both indices are in-bounds.
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Borda count aggregation over multiple rank lists.
 * Each rank list is a permutation of [0..N) in descending-relevance
 * order. A candidate at position k in a list earns (N-k) points.
 * Sum across all lists; sort by total points desc → final
 * permutation. Stable on ties (lower parent index wins).
 */
function bordaAggregate(rankings: number[][], n: number): number[] {
  const points = new Array<number>(n).fill(0);
  for (const rank of rankings) {
    for (const [pos, candidate] of rank.entries()) {
      points[candidate] = (points[candidate] ?? 0) + (n - pos);
    }
  }
  const indexed = Array.from({ length: n }, (_, i) => ({
    idx: i,
    score: points[i]!, // i < n = points.length ⇒ in-bounds
  }));
  indexed.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return indexed.map((x) => x.idx);
}
