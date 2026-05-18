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

export interface TypeDistribution {
  /** Entity type → weight in [0, 1]. Sums to ≤1. */
  weights: Record<string, number>;
}

export interface RouterClassification {
  predicates: PredicateDistribution;
  types: TypeDistribution;
}

const DEFAULT_VOCABULARY = [
  // CRM (unchanged)
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
  // Content-domain (v1.1)
  'brand_voice',
  'brand_archetype',
  'tone_of_voice',
  'product_description',
  'target_audience_segment',
  'content_guideline',
  'tension_point',
  'reference_example',
  'narrative_pillar',
  'forbidden_pattern',
] as const;

const TYPE_VOCABULARY = [
  'customer',
  'staff',
  'asset',
  'project',
  'topic',
  'location',
  'other',
] as const;

@Injectable()
export class PredicateRouterService {
  private readonly logger = new Logger(PredicateRouterService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly enabled: boolean;
  private readonly limiter: Semaphore;
  private readonly cache: Map<string, RouterClassification> = new Map();
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

  async route(query: string): Promise<RouterClassification | null> {
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

  private async classify(query: string): Promise<RouterClassification | null> {
    const sys = `You classify a search query into TWO joint distributions: the predicate-class it targets, and the entity-type it targets. The single LLM call returns both — they share the same query semantics, so co-classifying is cheaper than two separate calls.

Predicates in our knowledge graph:
- name: looking up an entity by who they are
- email, phone: contact channels
- address: physical location, residence, "from <place>", birthplace, "lives in", headquarters
- dob: date of birth — triggered by "born YYYY", "birthday", "birth date", "age", "date of birth", or any year that reads as a birth year
- status: lifecycle state ("active", "churned", "open")
- tier: segmentation tier ("platinum", "gold")
- intent: what someone wants, plans, asks for
- preference: stated or inferred preference
- complained_about: complaint / problem report / dissatisfaction
- interacted_with: a transaction, attendance, viewing, booking, contact
- said: a generic utterance (use as residual when nothing more specific fits)
- brand_voice: the brand's overall sound / personality description
- brand_archetype: Jungian archetype (Hero, Sage, Outlaw, Explorer, Magician, Lover, Jester, Caregiver, Creator, Ruler, Innocent, Everyman)
- tone_of_voice: writing-style attributes (e.g. "conversational, punchy, no jargon")
- product_description: short product or service summary
- target_audience_segment: a specific audience group the brand targets
- content_guideline: one editorial rule or content standard
- tension_point: customer pain or contradiction the content addresses
- reference_example: an example URL or quote of an exemplar content piece
- narrative_pillar: a recurring brand theme or strategic narrative
- forbidden_pattern: a writing anti-pattern or phrase the brand avoids

Entity types in our knowledge graph:
- customer: a customer / tenant / lead / patient / attendee
- staff: an employee / agent / contact at the operator side
- asset: a unit / property / product / order / ticket
- project: a campaign / project / event / initiative
- topic: a theme / category / abstract concept
- location: a physical place
- other: residual

Return a probability distribution over predicates AND a probability distribution over entity types. Each should sum to 1. Use higher mass (0.5+) for clear matches.

Examples of joint reasoning:
- "Project Phoenix kickoff" → predicate=interacted_with (event-attendance) targets a STAFF entity (the person who attended), NOT the project entity. types should give staff high mass, project low.
- "platinum tier customers" → predicate=tier targets a CUSTOMER entity. types: customer high.
- "broken washing machine" → predicate=complained_about targets a CUSTOMER entity (the complainer), not the asset. types: customer high.
- "Anton Chekhov born 1860" → name AND dob both carry mass (≈0.45 each). The query intent is identity verification by birth year — the dob predicate is what discriminates among same-name persons. types: customer (or other-person) high.
- "Mikhail Bulgakov from Kyiv" → address dominates (≈0.6) with name secondary (≈0.3). "from <place>" is the canonical address-lookup phrasing. types: customer / location both relevant.
- "Maya age 34" → dob dominates. Age expressions imply a birth-year window.`;
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
          name: 'router_classification',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              predicates: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(
                  DEFAULT_VOCABULARY.map((p) => [p, { type: 'number' }]),
                ),
                required: [...DEFAULT_VOCABULARY],
              },
              types: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(
                  TYPE_VOCABULARY.map((t) => [t, { type: 'number' }]),
                ),
                required: [...TYPE_VOCABULARY],
              },
            },
            required: ['predicates', 'types'],
          },
        },
      },
      max_completion_tokens: 384,
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
    const predicates = normalizeDist(parsed?.predicates, DEFAULT_VOCABULARY);
    const types = normalizeDist(parsed?.types, TYPE_VOCABULARY);
    if (!predicates || !types) return null;
    return { predicates: { weights: predicates }, types: { weights: types } };
  }
}

/**
 * Defensive distribution normalization. Clamps values to [0, 1] and
 * renormalises if the sum drifts more than 5% from 1 (LLMs sometimes
 * emit slightly off-mass distributions even with strict schemas).
 * Returns null if the raw input isn't an object.
 */
function normalizeDist(
  raw: unknown,
  vocab: readonly string[],
): Record<string, number> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const cleaned: Record<string, number> = {};
  let sum = 0;
  for (const k of vocab) {
    const v = typeof r[k] === 'number' ? (r[k] as number) : 0;
    const w = Math.max(0, Math.min(1, v));
    cleaned[k] = w;
    sum += w;
  }
  if (sum > 0 && Math.abs(sum - 1) > 0.05) {
    for (const k of vocab) cleaned[k] = cleaned[k] / sum;
  }
  return cleaned;
}
