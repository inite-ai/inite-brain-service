import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import { clampLlmInputText } from '../common/input-limits';

/**
 * One step in a multi-hop search plan. Produced by the planner LLM
 * from a free-text query, consumed by the executor.
 */
export interface HopPlan {
  /**
   * Natural-language sub-query for this hop. Goes into SearchService
   * as the `query` field (vector + lexical legs both run on it).
   */
  subQuery: string;

  /**
   * Optional predicate filter — narrows the hop to facts whose
   * predicate is in this set. `null` / omitted = no filter.
   */
  predicates?: string[] | null;

  /**
   * How this hop combines with the running entity-set:
   *   - `seed`              — first hop, ignores prior set (executor
   *                           seeds the chain with this hop's results)
   *   - `subset_of_previous`— scope the hop's search to the previous
   *                           hop's entity set (anchored via entityIds);
   *                           result is intersection
   *   - `intersect`         — run the hop unconstrained, intersect with
   *                           prior set after the fact (useful when the
   *                           sub-query is broad and the prior set is
   *                           small; preserves recall on hop 2)
   *   - `union`             — run unconstrained, union with prior set
   *                           (rarely useful in chained reasoning;
   *                           included for completeness)
   */
  combination: 'seed' | 'subset_of_previous' | 'intersect' | 'union';

  /**
   * Optional bitemporal anchor — set when the hop is sensitive to
   * "what was true at date X" (asOf semantics on knowledge_fact).
   * ISO-8601. Caller's request-level asOf is honoured separately.
   */
  asOf?: string | null;

  /**
   * Optional human-readable rationale for ops debugging. Doesn't
   * affect execution. The executor surfaces this in the response so
   * callers can audit how the planner decomposed their question.
   */
  rationale?: string | null;
}

export interface MultiHopPlan {
  hops: HopPlan[];
  /**
   * Whether the planner believes the chain answers the question.
   * The executor uses this to decide whether to fall back to a
   * single-shot search if the plan looks degenerate (e.g. one hop
   * with combination=seed and no clear chaining).
   */
  isMultiHop: boolean;
}

const PLANNER_SYSTEM = `You are a query planner for a multi-hop search over a knowledge graph.

The graph stores ENTITIES (customers, staff, assets, projects, topics, locations) and FACTS about them. Each fact has a predicate from a closed set:
  name | email | phone | status | tier | intent | preference | complained_about | interacted_with | address | dob | said

Some queries are SINGLE-HOP — one sub-query is enough. Examples:
  "platinum tier customers"               → 1 hop on tier
  "who complained about parking"          → 1 hop on complained_about

Some queries chain through entity sets (MULTI-HOP). Examples:
  "customers who complained in April AND upgraded to platinum after"
    → hop 1: complained in April  (seed)
    → hop 2: upgraded to platinum (subset_of_previous, asOf later than hop1)

  "staff who attended Project Phoenix kickoff"
    → hop 1: Project Phoenix kickoff attendees (seed, predicate=interacted_with)
    Single-hop is enough — the predicate already disambiguates.

  "tenants whose maintenance issues were closed by Sam"
    → hop 1: maintenance complaints (seed)
    → hop 2: closed by Sam (subset_of_previous on the same entities)

Plan output rules:
- ≤ 4 hops. Most queries are 1-2 hops.
- First hop ALWAYS combination='seed'.
- Later hops choose combination among 'subset_of_previous', 'intersect', 'union'.
  Use 'subset_of_previous' when the chain is "FROM the previous result, KEEP those that ALSO …" — most chained reasoning.
  Use 'intersect' when both hops are independent broad queries and you want their overlap.
  Use 'union' rarely (e.g. "platinum OR gold customers who complained" — but this is usually one hop with predicate filter).
- subQuery: a focused phrase, NOT the original full question. The downstream search engine has hybrid retrieval; give it a clean signal.
- predicates: include when the sub-query clearly targets one or two predicates. Skip when ambiguous.
- asOf: include when a temporal phrase ("in April", "before the upgrade", "last quarter") refers to the validity timeline. Use ISO-8601. Resolve relative dates against today (you'll be told today's date).
- isMultiHop=false when one hop is enough; the executor will short-circuit to single-shot search.

Output strictly the JSON shape requested by the schema. No preamble, no chain-of-thought.`;

@Injectable()
export class MultiHopPlannerService {
  private readonly logger = new Logger(MultiHopPlannerService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly limiter: Semaphore;

  constructor(private readonly configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: parseInt(
        this.configService.get<string>('OPENAI_TIMEOUT_MS', '30000'),
        10,
      ),
      maxRetries: parseInt(
        this.configService.get<string>('OPENAI_MAX_RETRIES', '3'),
        10,
      ),
    });
    this.model = this.configService.get<string>(
      'MULTI_HOP_PLANNER_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('MULTI_HOP_PLANNER_CONCURRENCY', '4'),
        10,
      ),
    );
  }

  async plan(query: string, maxHops: number): Promise<MultiHopPlan | null> {
    const { value: clamped } = clampLlmInputText(query ?? '', 'query');
    if (!clamped) return null;
    const today = new Date().toISOString().slice(0, 10);
    const user = `Today: ${today}\nMax hops: ${maxHops}\nQuery: ${clamped}`;
    try {
      return await this.limiter.run(() => this.callLLM(user, maxHops));
    } catch (err) {
      this.logger.warn(`Planner failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async callLLM(
    user: string,
    maxHops: number,
  ): Promise<MultiHopPlan | null> {
    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'multi_hop_plan',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              isMultiHop: { type: 'boolean' },
              hops: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    subQuery: { type: 'string' },
                    predicates: {
                      type: ['array', 'null'],
                      items: { type: 'string' },
                    },
                    combination: {
                      type: 'string',
                      enum: [
                        'seed',
                        'subset_of_previous',
                        'intersect',
                        'union',
                      ],
                    },
                    asOf: { type: ['string', 'null'] },
                    rationale: { type: ['string', 'null'] },
                  },
                  required: [
                    'subQuery',
                    'predicates',
                    'combination',
                    'asOf',
                    'rationale',
                  ],
                },
              },
            },
            required: ['isMultiHop', 'hops'],
          },
        },
      },
      max_completion_tokens: 768,
      temperature: 0,
    });
    const content = res.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as MultiHopPlan;
    if (!Array.isArray(parsed.hops) || parsed.hops.length === 0) return null;
    // Defensive: enforce caps + first-hop=seed invariant. The schema
    // says combination is one of the four; we belt-and-braces force
    // hops[0] to be seed because executors downstream rely on it.
    if (parsed.hops[0].combination !== 'seed') {
      parsed.hops[0].combination = 'seed';
    }
    if (parsed.hops.length > maxHops) {
      parsed.hops = parsed.hops.slice(0, maxHops);
    }
    return parsed;
  }
}
