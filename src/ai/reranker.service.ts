import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';

export interface RerankCandidate {
  /** A short label identifying the candidate (e.g. canonical name). */
  label: string;
  /** A few-line summary of the candidate's facts to score against. */
  body: string;
}

/**
 * Listwise re-ranker. Takes a query and an ordered list of fused
 * candidates and returns a permutation of indices in descending
 * relevance order. Single LLM call (RankGPT-style prompt) — joint
 * scoring of (query, candidate) lets the model encode IS-A and
 * predicate-class semantics that pooled embeddings miss.
 *
 * Disabled by default. Enable with SEARCH_RERANKER_ENABLED=1 + an
 * OpenAI key. On any failure (timeout, malformed output, partial
 * permutation) we return the original order so retrieval never
 * breaks because of the optional reranker.
 */
@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly enabled: boolean;
  private readonly limiter: Semaphore;

  constructor(private readonly configService: ConfigService) {
    this.enabled =
      this.configService.get<string>('SEARCH_RERANKER_ENABLED', '0') === '1';
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey
      ? new OpenAI({
          apiKey,
          timeout: parseInt(
            this.configService.get<string>('OPENAI_TIMEOUT_MS', '30000'),
            10,
          ),
          maxRetries: parseInt(
            this.configService.get<string>('OPENAI_MAX_RETRIES', '3'),
            10,
          ),
        })
      : (undefined as unknown as OpenAI);
    this.model = this.configService.get<string>(
      'SEARCH_RERANKER_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('SEARCH_RERANKER_CONCURRENCY', '4'),
        10,
      ),
    );
  }

  isEnabled(): boolean {
    return this.enabled && !!this.openai;
  }

  /**
   * Re-rank the candidates against the query. Returns a permutation
   * of `[0..candidates.length)` in descending-relevance order. On
   * any failure or when disabled, returns the identity permutation.
   *
   * Skip when ≤1 candidate or query is empty — no re-ranking work
   * to do, no LLM call worth paying for.
   */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<number[]> {
    const identity = candidates.map((_, i) => i);
    if (!this.isEnabled() || candidates.length <= 1 || !query.trim()) {
      return identity;
    }

    const items = candidates
      .map((c, i) => `[${i}] ${c.label}\n${c.body}`)
      .join('\n\n');
    const systemPrompt = `You are a relevance ranker for a knowledge-graph search system. Given a user query and a list of candidate entities (each with a label and a short summary of facts), reorder the candidates from MOST to LEAST relevant to the query.

Use the literal text of the facts; don't invent missing context. Prefer candidates whose facts directly answer the query (object terms, predicate semantics, IS-A reasoning). When two candidates are similarly relevant, favour the one with more directly-supporting evidence.

Return ONLY a JSON object of the shape {"ranking": [<index>, ...]} listing every candidate index from the input exactly once, in the new order.`;
    const userPrompt = `Query: ${query}\n\nCandidates:\n${items}`;

    try {
      const res = await this.limiter.run(() =>
        this.openai.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          // Strict JSON schema: ranking must be an integer array.
          // We cap minItems/maxItems via runtime validation rather
          // than schema (json_schema enum doesn't accept dynamic
          // sizes per call).
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
        }),
      );

      const content = res.choices[0]?.message?.content;
      if (!content) return identity;
      const parsed = JSON.parse(content);
      const ranking: unknown = parsed?.ranking;
      if (!Array.isArray(ranking)) return identity;

      // Validate: must be a permutation of [0..N) with no duplicates,
      // no out-of-range indices, and the same length. Anything off and
      // we fall back to the original order rather than emit a
      // partially-rewritten ranking that drops or duplicates results.
      const seen = new Set<number>();
      const validated: number[] = [];
      for (const x of ranking) {
        if (typeof x !== 'number' || !Number.isInteger(x)) return identity;
        if (x < 0 || x >= candidates.length) return identity;
        if (seen.has(x)) return identity;
        seen.add(x);
        validated.push(x);
      }
      if (validated.length !== candidates.length) return identity;
      return validated;
    } catch (err) {
      this.logger.warn(`Reranker failed, falling back: ${(err as Error).message}`);
      return identity;
    }
  }
}
