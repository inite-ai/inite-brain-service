import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClient } from './openai-client';
import { MetricsService } from '../metrics/metrics.service';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';

/**
 * PredicateIdentityJudgeService — does a newly coined predicate name an
 * attribute the graph ALREADY has under a different name?
 *
 * WHY IT EXISTS. `canonicalize()` decides that question by cosine alone:
 * above DEFAULT_CANONICALIZE_AUTO_ALIAS_THRESHOLD it aliases, below it
 * proposes a brand-new predicate. Measured on a live memory-fitness
 * tenant, that leaves one attribute scattered across many slots —
 * `deploy_target`, `deploys_to` and `deploys` for where a service
 * deploys; `queue_backend` beside `job_queue_backend`;
 * `pilot_launch_date` beside `changed_launch_date`. Nothing supersedes
 * across two predicates, so each fragment keeps its own value active
 * forever and "what is it NOW" has no answer to give — the same failure
 * the cardinality judge fixes WITHIN a slot, one level up.
 *
 * WHY NOT JUST MOVE THE THRESHOLD. Because the signal is not there.
 * Cosine over the coinage context, over the bare predicate name, and
 * over a templated attribute phrase were all measured on the same 196-
 * predicate vocabulary, and NONE separates same-attribute pairs from
 * different-attribute pairs — the best variant scores
 * `retry_policy`~`retry_attempts` (two different fields) at 0.790,
 * ABOVE `pilot_launch_date`~`changed_launch_date` (one field) at 0.721.
 * No threshold exists. What cosine IS good at is recall: over that same
 * vocabulary the true partner landed in the top 3 every time (ranks
 * 1,2,1,1,2). So embeddings shortlist and this judge decides — the
 * division of labour the numbers actually support.
 *
 * CONSERVATIVE BY CONSTRUCTION, and asymmetrically so: a wrong merge
 * silently destroys an attribute (its values fold into another slot and
 * supersede each other), while a missed merge only leaves the duplicate
 * that exists today. So ambiguity, an unparseable reply, an id that was
 * not offered, a missing key and any throw all resolve to "no match" —
 * today's behaviour. Measured on the pairs above: 9/9 substantively
 * correct, zero false merges, and it twice rejected the TOP cosine
 * candidate (`retry_attempts` at 0.84 for `retry_delay`).
 */
@Injectable()
export class PredicateIdentityJudgeService {
  private readonly logger = new Logger(PredicateIdentityJudgeService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly limiter: Semaphore;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.openai = createOpenAiClient(this.config) ?? (undefined as unknown as OpenAI);
    this.model = this.config.get<string>(
      'PREDICATE_IDENTITY_MODEL',
      this.config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(this.config.get<string>('PREDICATE_IDENTITY_CONCURRENCY', '4'), 10) || 4,
    );
  }

  /** True when a key is configured, so an adjudication is possible. */
  isAvailable(): boolean {
    return !!this.openai;
  }

  /**
   * Which of `candidates` names the same attribute as `predicate`, or
   * null when none does. ONE call for the whole shortlist — the model
   * compares the candidates against each other, which is exactly the
   * judgment a per-pair call cannot make.
   *
   * @param predicate   the coined predicate id (e.g. `job_queue_backend`)
   * @param contextText predicate + object (+ clause) — the same text the
   *                    canonicalize pass embeds, so the judge sees the
   *                    statement the coinage came from
   * @param candidates  existing predicate ids, best cosine first
   */
  async sameAttributeAs(
    predicate: string,
    contextText: string,
    candidates: readonly string[],
  ): Promise<string | null> {
    if (!this.openai || candidates.length === 0) return null;
    try {
      return await this.limiter.run(() => this.callLLM(predicate, contextText, candidates));
    } catch (err) {
      this.logger.warn(
        `predicate identity judge failed for '${predicate}': ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async callLLM(
    predicate: string,
    contextText: string,
    candidates: readonly string[],
  ): Promise<string | null> {
    const sys = `You decide whether a NEW knowledge-graph predicate names the SAME ATTRIBUTE as one the graph already has.

Two names are the same attribute when a subject holds only ONE of them at a time and a statement using either name answers the SAME question about that subject. Ask: "would a person filling in a form put these under one field, or two?"

SAME attribute — merge:
- a verb phrasing of the same thing: "deploys_to" / "deploy_target" — where it is deployed
- a redundant qualifier: "job_queue_backend" / "queue_backend" — which queue backend
- the CHANGE to it: "changed_launch_date" / "pilot_launch_date" — the launch date
- a PAST value of it: "fixed_retry_policy" / "retry_policy" — the retry policy

DIFFERENT attributes — do NOT merge (the default):
- sub-attributes of one topic: "retry_delay", "retry_attempts" and "retry_policy" are three fields, not one
- a rate or interval vs the thing it applies to: "drains_to_queue_interval" vs "queue_backend"
- a RELATION to another entity rather than a value the subject holds: "replaces", "superseded_by", "depends_on", "owns"
- anything you are not confident about

Merging two distinct attributes silently destroys one of them, while leaving a duplicate merely costs a redundant field. When two readings are both plausible, answer null.

Reply with the EXACT id of the one existing predicate that names the same attribute, or null when none does. Never invent an id that is not listed.`;

    const user = `New predicate: "${predicate}"\nExample use: ${contextText}\n\nExisting predicates:\n${candidates
      .map((c) => `- "${c}"`)
      .join('\n')}`;

    const res = await withGenAiCall(
      {
        kind: 'chat',
        spanName: 'gen_ai.chat.predicate_identity',
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
              name: 'same_attribute',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { sameAttributeAs: { type: ['string', 'null'] } },
                required: ['sameAttributeAs'],
              },
            },
          },
          max_completion_tokens: 32,
          temperature: 0,
        }),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { sameAttributeAs: unknown };
    const picked = parsed.sameAttributeAs;
    if (typeof picked !== 'string') return null;
    const trimmed = picked.trim();
    // A nullable strict-JSON field comes back as the LITERAL string
    // "null" often enough to matter (observed while calibrating this
    // prompt), and an empty string means the same thing.
    if (trimmed === '' || trimmed === 'null') return null;
    // Fence: only an id we actually offered can win. The model is told
    // never to invent one; this makes that structural rather than
    // hopeful — a hallucinated id would alias a live slot onto a
    // predicate that does not exist.
    return candidates.includes(trimmed) ? trimmed : null;
  }
}
