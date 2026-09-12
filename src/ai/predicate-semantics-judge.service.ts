import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClient } from './openai-client';
import { MetricsService } from '../metrics/metrics.service';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';
import type { Semantics } from './predicate-registry-internals/types';

/**
 * PredicateSemanticsJudgeService — the "LLM-classify pass" the
 * canonicalize propose branch has been deferring to since 0082
 * ("Inherits DEFAULT policy until an operator (or a future LLM-classify
 * pass) sets the proper one").
 *
 * WHY IT MATTERS. Every predicate the extractor coins was registered
 * `append_only`, and `append_only` means "no conflict is possible at
 * ingest": the prior value is never closed, never superseded, never
 * marked competing. Measured on a live tenant: 186 of 223 predicates
 * were auto-coined and ALL 186 were append_only — only the 15 seeded
 * `single_active` predicates could express "this value replaced that
 * one". So for anything outside the seed ontology — deploy_target,
 * queue_backend, retry_policy, pilot_launch_date, payout_cutoff — the
 * old value stayed active forever beside the new one, and "what is it
 * NOW" had no answer to give. Three memory-fitness dimensions (currency,
 * evolution, conflict surfacing) were failing on that one cause.
 *
 * THE QUESTION is cardinality over time, and it is a judgment about
 * language, which is what makes it an LLM's job rather than a suffix
 * table: does a new value RETIRE the old one?
 *
 * CONSERVATIVE BY CONSTRUCTION. Ambiguity resolves to `append_only`,
 * today's behaviour — so this pass only ever ADDS supersession where the
 * model is confident. That asymmetry is deliberate: wrongly calling a
 * multi-valued predicate single_active silently retires facts that
 * should coexist, while the reverse merely leaves a disagreement
 * standing for a later pass (and for the competing-facts surface) to
 * adjudicate. Any failure — no API key, a throw, an unparseable
 * response — degrades to `append_only` and never blocks ingest.
 *
 * Applies to NEWLY PROPOSED predicates only. Aliased coinages already
 * inherit their canon's semantics, seeded predicates are hand-classified,
 * and an operator's explicit choice is never overwritten.
 */
@Injectable()
export class PredicateSemanticsJudgeService {
  private readonly logger = new Logger(PredicateSemanticsJudgeService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly limiter: Semaphore;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.openai = createOpenAiClient(this.config) ?? (undefined as unknown as OpenAI);
    this.model = this.config.get<string>(
      'PREDICATE_SEMANTICS_MODEL',
      this.config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(this.config.get<string>('PREDICATE_SEMANTICS_CONCURRENCY', '4'), 10) || 4,
    );
  }

  /** True when a key is configured, so a classification is possible. */
  isAvailable(): boolean {
    return !!this.openai;
  }

  /**
   * Classify a novel predicate. Returns `append_only` — the historical
   * default — for every failure mode, so the caller can use the result
   * unconditionally.
   *
   * @param predicate    the coined predicate id (e.g. `payout_cutoff`)
   * @param contextText  predicate + object (+ clause), the same text the
   *                     canonicalize pass embeds for similarity
   * @param nearest      closest existing predicate and its semantics, when
   *                     one scored above the reporting floor — a hint, not
   *                     an answer (it sits BELOW the alias threshold, or we
   *                     would have aliased instead of proposing)
   */
  async classify(
    predicate: string,
    contextText: string,
    nearest?: { predicateId: string; semantics: Semantics; similarity: number } | undefined,
  ): Promise<Semantics> {
    if (!this.openai) return 'append_only';
    try {
      return await this.limiter.run(() => this.callLLM(predicate, contextText, nearest));
    } catch (err) {
      this.logger.warn(
        `predicate semantics classify failed for '${predicate}': ${(err as Error).message}`,
      );
      return 'append_only';
    }
  }

  private async callLLM(
    predicate: string,
    contextText: string,
    nearest?: { predicateId: string; semantics: Semantics; similarity: number } | undefined,
  ): Promise<Semantics> {
    const sys = `You classify a new knowledge-graph predicate by its CARDINALITY OVER TIME.

Answer exactly one question: when the subject gets a NEW value for this predicate, does the PREVIOUS value stop being true?

- "single_active" — yes. The predicate names a STATE that has one true value at a time: a current setting, a status, a chosen option, a scheduled date, a version, a limit, a target, a rate. A later value REPLACES the earlier one, which becomes history.
  e.g. deploy_target, queue_backend, retry_policy, pilot_launch_date, payout_cutoff, dependency_version, subscription_tier, office_address, employment_status

- "append_only" — no. The predicate names an EVENT, an observation, a preference, a capability, or anything naturally multi-valued, where the earlier value REMAINS true and the history is the point.
  e.g. mentioned_topic, attended_event, complained_about, favorite_cuisine, speaks_language, skill, purchased_item, reported_symptom

Judge the predicate, not the one example: "purchased_item" is append_only even though someone can buy the same thing twice, and "office_address" is single_active even if the example shows only one address.

When the two readings are genuinely equally plausible, answer "append_only". Wrongly marking a multi-valued predicate single_active silently retires facts that should coexist; the reverse only leaves a disagreement standing for a later pass to adjudicate.

Output strictly the JSON shape requested. No preamble.`;

    // The nearest predicate sits BELOW the alias threshold by
    // construction — close enough to inform, too far to inherit from.
    const nearestLine =
      nearest !== undefined
        ? `\n\nNearest existing predicate: "${nearest.predicateId}" (${nearest.semantics}) at cosine ${nearest.similarity.toFixed(3)} — related, but not the same predicate.`
        : '';
    const user = `Predicate: "${predicate}"\nExample use: ${contextText}${nearestLine}`;

    const res = await withGenAiCall(
      {
        kind: 'chat',
        spanName: 'gen_ai.chat.predicate_semantics',
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
              name: 'predicate_semantics',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  semantics: { type: 'string', enum: ['single_active', 'append_only'] },
                },
                required: ['semantics'],
              },
            },
          },
          max_completion_tokens: 32,
          temperature: 0,
        }),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) return 'append_only';
    const parsed = JSON.parse(content) as { semantics: unknown };
    // 'bitemporal' is deliberately NOT offered: it needs a similarity
    // threshold and a margin per predicate, which is an operator decision,
    // not something to guess from one coinage.
    return parsed.semantics === 'single_active' ? 'single_active' : 'append_only';
  }
}
