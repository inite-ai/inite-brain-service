import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import OpenAI from 'openai';
import { MetricsService } from '../metrics/metrics.service';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';

export type EntityVerdict = 'same' | 'different' | 'unsure';

/**
 * EntityJudgeService — the single LLM "are these two entities the same
 * real-world thing?" decision, shared by:
 *   - the off-hours dreams dedup (candidate name-pairs), and
 *   - inline entity resolution at ingest (an extracted entity vs an
 *     existing one).
 *
 * Both used to carry their own OpenAI client + Semaphore + judge prompt +
 * fetchTopFacts; this consolidates them so the reasoning rules and tuning
 * evolve in one place. Lives in the @Global AiModule, so any caller injects
 * it directly.
 *
 * The verdict is fact-driven and conservative: when the facts don't
 * disambiguate, it returns "unsure" and the prompt biases toward
 * "different" — wrongly fusing two distinct entities is worse than a
 * transient duplicate a later pass can still merge. Any LLM/parse failure
 * degrades to "unsure" (never throws), so callers never block on it.
 */
@Injectable()
export class EntityJudgeService {
  private readonly logger = new Logger(EntityJudgeService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly limiter: Semaphore;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    this.openai = apiKey
      ? new OpenAI({
          apiKey,
          timeout: parseInt(
            this.config.get<string>('OPENAI_TIMEOUT_MS', '30000'),
            10,
          ),
          maxRetries: parseInt(
            this.config.get<string>('OPENAI_MAX_RETRIES', '3'),
            10,
          ),
        })
      : (undefined as unknown as OpenAI);
    this.model = this.config.get<string>(
      'ENTITY_JUDGE_MODEL',
      this.config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    // Shared judge concurrency. Falls back to the legacy DREAMS_DEDUP knob
    // so existing operator tuning keeps working after the consolidation.
    this.limiter = new Semaphore(
      parseInt(
        this.config.get<string>(
          'ENTITY_JUDGE_CONCURRENCY',
          this.config.get<string>('DREAMS_DEDUP_CONCURRENCY', '4'),
        ),
        10,
      ),
    );
  }

  /** True when an OpenAI key is configured (so a judge call is possible). */
  isAvailable(): boolean {
    return !!this.openai;
  }

  /**
   * Top active facts for an entity, rendered as `- predicate: object`
   * lines — the judge's evidence for one side. Shared by both call sites.
   */
  async fetchTopFacts(db: Surreal, entityId: string): Promise<string> {
    type R = { predicate: string; object: string };
    const [rows] = await db.query<[R[]]>(
      `SELECT predicate, object FROM knowledge_fact
         WHERE entityId = $eid
           AND status = 'active'
           AND retractedAt IS NONE
         ORDER BY confidence DESC
         LIMIT 5`,
      { eid: new StringRecordId(entityId) },
    );
    const r = (rows as R[]) ?? [];
    if (r.length === 0) return '(no facts)';
    return r.map((f) => `- ${f.predicate}: ${f.object}`).join('\n');
  }

  /**
   * Decide whether the two fact-blocks describe the same entity. Runs under
   * the shared concurrency limiter. Returns "unsure" on any failure.
   *
   * @param left   rendered facts for side A (e.g. an existing entity)
   * @param right  rendered facts for side B (e.g. the incoming mention)
   * @param ctx.cosine optional name cosine-similarity hint for the prompt
   */
  async judge(
    left: string,
    right: string,
    ctx: { cosine?: number } = {},
  ): Promise<EntityVerdict> {
    if (!this.openai) return 'unsure';
    try {
      return await this.limiter.run(() => this.callLLM(left, right, ctx));
    } catch (err) {
      this.logger.warn(`entity judge failed: ${(err as Error).message}`);
      return 'unsure';
    }
  }

  private async callLLM(
    left: string,
    right: string,
    ctx: { cosine?: number },
  ): Promise<EntityVerdict> {
    const sys = `You decide whether two knowledge-graph entities are the SAME real-world thing or DIFFERENT things that happen to share a similar name.

Use the facts as the only evidence:
- "same" — facts directly identify them (matching dob / email / address / employer) OR facts are non-contradictory and the names are identical / clear aliases.
- "different" — facts contradict (different dob / different email / different employer at the same time).
- "unsure" — the facts don't disambiguate either way (just names + occupation, common name).

When unsure, prefer "different" — wrongly fusing two distinct entities is worse than a transient duplicate a later pass can still merge.

Output strictly the JSON shape requested. No preamble.`;
    const cosineLine =
      typeof ctx.cosine === 'number'
        ? `\n\nCosine name-similarity: ${ctx.cosine.toFixed(3)}.`
        : '';
    const user = `Entity A:\n${left}\n\nEntity B:\n${right}${cosineLine}`;

    const res = await withGenAiCall(
      {
        kind: 'chat',
        spanName: 'gen_ai.chat.entity_judge',
        system: 'openai',
        model: this.model,
      },
      this.metrics,
      () =>
        this.openai.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'entity_judge_verdict',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  verdict: {
                    type: 'string',
                    enum: ['same', 'different', 'unsure'],
                  },
                },
                required: ['verdict'],
              },
            },
          },
          max_completion_tokens: 64,
          temperature: 0,
        }),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) return 'unsure';
    const parsed = JSON.parse(content) as { verdict: unknown };
    if (
      parsed.verdict === 'same' ||
      parsed.verdict === 'different' ||
      parsed.verdict === 'unsure'
    ) {
      return parsed.verdict;
    }
    return 'unsure';
  }
}
