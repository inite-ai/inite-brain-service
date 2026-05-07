import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import { createHash } from 'node:crypto';

/**
 * Predicate-class query router.
 *
 * Classifies a free-text query into a soft distribution over the
 * extractor's predicate vocabulary (`name`, `complained_about`,
 * `tier`, `intent`, `interacted_with`, ...). The search ranker
 * applies a multiplicative boost to facts whose predicate falls in
 * the high-mass classes — so a query like "tier upgrade" gets a
 * boost on tier-predicate facts even when the embedding signal
 * is ambiguous, and "parking issues" prefers `complained_about`
 * facts over `interacted_with` facts on the same topic.
 *
 * Cached per-query (LRU) — same operator UI tends to issue the
 * same shape of queries repeatedly, so a single LLM call usually
 * amortises across many requests.
 *
 * Disabled by default (SEARCH_PREDICATE_ROUTER_ENABLED). When off,
 * `route()` returns null and the ranker bypass'es the boost step.
 */
export interface PredicateDistribution {
  /** Predicate → weight in [0, 1]. Sums to ≤1. Missing keys = 0. */
  weights: Record<string, number>;
}

const DEFAULT_VOCABULARY = [
  'name',
  'email',
  'phone',
  'status',
  'tier',
  'intent',
  'preference',
  'complained_about',
  'interacted_with',
  'address',
  'dob',
  'said',
] as const;

@Injectable()
export class PredicateRouterService {
  private readonly logger = new Logger(PredicateRouterService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly enabled: boolean;
  private readonly limiter: Semaphore;
  private readonly cache: Map<string, PredicateDistribution> = new Map();
  private readonly cacheLimit: number;

  constructor(private readonly configService: ConfigService) {
    this.enabled =
      this.configService.get<string>('SEARCH_PREDICATE_ROUTER_ENABLED', '0') ===
      '1';
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
      'SEARCH_PREDICATE_ROUTER_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('SEARCH_PREDICATE_ROUTER_CONCURRENCY', '4'),
        10,
      ),
    );
    this.cacheLimit = parseInt(
      this.configService.get<string>('SEARCH_PREDICATE_ROUTER_CACHE', '500'),
      10,
    );
  }

  isEnabled(): boolean {
    return this.enabled && !!this.openai;
  }

  async route(query: string): Promise<PredicateDistribution | null> {
    if (!this.isEnabled() || !query.trim()) return null;
    const key = createHash('sha256').update(query.trim().toLowerCase()).digest('hex');
    const cached = this.cache.get(key);
    if (cached) return cached;

    try {
      const dist = await this.limiter.run(() => this.classify(query));
      if (!dist) return null;
      // Bounded LRU — tiny: drop the oldest insertion when full.
      if (this.cache.size >= this.cacheLimit) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(key, dist);
      return dist;
    } catch (err) {
      this.logger.warn(
        `Predicate router classify failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async classify(query: string): Promise<PredicateDistribution | null> {
    const sys = `You classify a search query into the predicate-class distribution it most likely targets. The predicates in our knowledge graph:

- name: looking up an entity by who they are
- email, phone, address, dob: contact / identity attributes
- status: lifecycle state ("active", "churned", "open")
- tier: segmentation tier ("platinum", "gold")
- intent: what someone wants, plans, asks for
- preference: stated or inferred preference
- complained_about: complaint / problem report / dissatisfaction
- interacted_with: a transaction, attendance, viewing, booking, contact
- said: a generic utterance (use as residual when nothing more specific fits)

Return a probability distribution over these predicates that sums to 1. Use higher mass (0.5+) for clear matches; spread mass across 2-3 predicates when the query is genuinely multi-class.`;
    const user = `Query: ${query}`;

    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'predicate_distribution',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              weights: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(
                  DEFAULT_VOCABULARY.map((p) => [p, { type: 'number' }]),
                ),
                required: [...DEFAULT_VOCABULARY],
              },
            },
            required: ['weights'],
          },
        },
      },
      max_completion_tokens: 256,
      temperature: 0,
    });
    const content = res.choices[0]?.message?.content;
    if (!content) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    const raw = parsed?.weights;
    if (!raw || typeof raw !== 'object') return null;
    // Normalize defensively — strict schema gives all keys as numbers
    // but we still want to clamp to [0, 1] and renormalize so the
    // boost computation downstream stays bounded.
    const cleaned: Record<string, number> = {};
    let sum = 0;
    for (const k of DEFAULT_VOCABULARY) {
      const v = typeof raw[k] === 'number' ? raw[k] : 0;
      const w = Math.max(0, Math.min(1, v));
      cleaned[k] = w;
      sum += w;
    }
    if (sum > 0 && Math.abs(sum - 1) > 0.05) {
      // Tolerate slight model drift; renormalize.
      for (const k of DEFAULT_VOCABULARY) cleaned[k] = cleaned[k] / sum;
    }
    return { weights: cleaned };
  }
}
