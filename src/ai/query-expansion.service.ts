import { Injectable, Logger, Optional } from '@nestjs/common';
import { envFlagEnabled } from '../common/env-validation';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClient } from './openai-client';
import { createHash } from 'node:crypto';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';
import { getAbortSignal } from '../common/request-context';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Read-side multi-query expansion.
 *
 * HyPE closes the question→statement gap on the WRITE side (facts store
 * a hypothetical-question altEmbedding); nothing reformulated the query
 * on the READ side — a query phrased unlike both the fact text and its
 * hypothetical question missed on the vector leg. This service rewrites
 * the query into N alternative phrasings; the retrieval stage runs one
 * extra vector leg per phrasing and merges by max cosine.
 *
 * Same operational contract as the predicate router: disabled by
 * default (SEARCH_QUERY_EXPANSION_ENABLED), per-query LRU cache,
 * bounded concurrency, and every failure path degrades to [] — the
 * original-query legs always run regardless.
 */
@Injectable()
export class QueryExpansionService {
  private readonly logger = new Logger(QueryExpansionService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly enabled: boolean;
  private readonly n: number;
  private readonly limiter: Semaphore;
  private readonly cache: Map<string, string[]> = new Map();
  private readonly cacheLimit: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled =
      envFlagEnabled(
        this.configService.get<string>('SEARCH_QUERY_EXPANSION_ENABLED'),
      );
    this.openai =
      createOpenAiClient(this.configService) ?? (undefined as unknown as OpenAI);
    this.model = this.configService.get<string>(
      'SEARCH_QUERY_EXPANSION_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    // 1..4 reformulations — each costs one embed + one vector query.
    const rawN = parseInt(
      this.configService.get<string>('SEARCH_QUERY_EXPANSION_N', '2'),
      10,
    );
    this.n = Number.isFinite(rawN) ? Math.min(4, Math.max(1, rawN)) : 2;
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('SEARCH_QUERY_EXPANSION_CONCURRENCY', '4'),
        10,
      ),
    );
    this.cacheLimit = parseInt(
      this.configService.get<string>('SEARCH_QUERY_EXPANSION_CACHE', '500'),
      10,
    );
  }

  isEnabled(): boolean {
    return this.enabled && !!this.openai;
  }

  /** Reformulations of `query` (never includes the original; [] on any failure). */
  async expand(query: string): Promise<string[]> {
    if (!this.isEnabled() || !query.trim()) return [];
    const key = createHash('sha256')
      .update(query.trim().toLowerCase())
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached) return cached;

    try {
      const alts = await this.limiter.run(() => this.reformulate(query));
      if (this.cache.size >= this.cacheLimit) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(key, alts);
      return alts;
    } catch (err) {
      this.logger.warn(
        `Query expansion failed: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private async reformulate(query: string): Promise<string[]> {
    const sys = `You rewrite a knowledge-graph search query into ${this.n} alternative phrasings for embedding-based retrieval.

The graph stores facts as short (entity, predicate, value) statements — e.g. "tier: platinum", "complained_about: broken washing machine", "address: Kyiv". Queries miss when their wording is far from how the fact was written down.

Rules:
- Stay in the query's language.
- Each alternative must take a genuinely different angle: statement form instead of question form, a synonym of the key term, the attribute-value phrasing an extractor would have stored.
- Keep every named entity EXACTLY as written (names, ids, emails are matching keys — never translate, inflect, or paraphrase them).
- No explanations, no numbering — just the rewritten queries.`;
    const res = await withGenAiCall(
      {
        kind: 'chat',
        spanName: 'gen_ai.chat.query_expansion',
        system: 'openai',
        model: this.model,
      },
      this.metrics,
      () =>
        this.openai.chat.completions.create(
          {
            model: this.model,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: `Query: ${query}` },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'query_expansion',
                strict: true,
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    queries: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['queries'],
                },
              },
            },
            max_completion_tokens: 256,
            temperature: 0,
          },
          { signal: getAbortSignal() },
        ),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) return [];
    let parsed: { queries?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed.queries)) return [];
    const original = query.trim().toLowerCase();
    return parsed.queries
      .filter((q): q is string => typeof q === 'string')
      .map((q) => q.trim())
      .filter((q) => q.length > 0 && q.length <= 512)
      .filter((q) => q.toLowerCase() !== original)
      .slice(0, this.n);
  }
}
