import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import OpenAI from 'openai';
import { createOpenAiClient } from './openai-client';
import { MetricsService } from '../metrics/metrics.service';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';

export type EntityVerdict = 'same' | 'different' | 'unsure';

/**
 * What the judge is told beside the two fact lists.
 *
 * `names` matter more than they look. The judge decides on facts, and for
 * two mentions of one person written in two scripts the facts are usually
 * the same facts in two languages — which reads as "no shared evidence"
 * unless the judge is also told that the two NAMES transliterate to each
 * other. Without the names it was handed "Cosine name-similarity: 0.846"
 * and two fact lists in different languages, and said "different" for
 * "Fyodor Volkov" vs "Фёдор Волков" with the same employer and role.
 */
export interface JudgeContext {
  /** Similarity on the candidate scan's own scale (see `similarity`). */
  cosine?: number;
  /**
   * Which scan produced the candidate — an embedding cosine, or the
   * normalised edit distance over transliterated names turned into a
   * similarity. Named so the prompt does not call a string distance a
   * cosine.
   */
  similarity?: 'embedding' | 'transliteration';
  /** The two surface names, when the caller has them. */
  names?: { a?: string | undefined; b?: string | undefined };
}

function nameLine(name: string | undefined): string {
  return name ? ` ${name}` : '';
}

function similarityLine(ctx: JudgeContext): string {
  if (typeof ctx.cosine !== 'number') return '';
  if (ctx.similarity === 'transliteration') {
    // This is not a hint about meaning; it is a statement about the NAMES.
    // Two names that agree this closely once written in one script are the
    // same name — the residue is a transliteration scheme (Ё as "e" or
    // "yo"), a doubled letter, a dropped vowel. The judge's usual rule,
    // "names plus an occupation do not disambiguate", exists for
    // embedding candidates whose names may genuinely differ. Here the name
    // is the identifying fact, and the question left is only whether the
    // other facts CONTRADICT it.
    return (
      `\n\nThe two names, transliterated to one script, agree to ` +
      `${(ctx.cosine * 100).toFixed(0)}%. Names this close are usually one name written two ` +
      `ways, so answer "same" when the facts are consistent — do not answer "different" or ` +
      `"unsure" merely because the facts are few or are stated in different languages. ` +
      `But a contradicting fact wins over the name: a different role or title at the same ` +
      `employer at the same time, a different employer, a different date of birth or email ` +
      `is "different". And a residual spelling difference can itself mark a different ` +
      `person — a surname that differs by an ending is often a relative or the other ` +
      `gender — so when the names are NOT identical after transliteration, require at ` +
      `least one fact in common beyond the employer before answering "same".`
    );
  }
  return `\n\nCosine name-similarity: ${ctx.cosine.toFixed(3)}.`;
}

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
    this.openai = createOpenAiClient(this.config) ?? (undefined as unknown as OpenAI);
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
    type E = { kind: string; other?: string };
    const eid = new StringRecordId(entityId);
    // No `userId IS NONE` on the facts. That fence used to be here, copied
    // from the entity-level privacy fence, and on a per-user-scoped tenant
    // — where mention ingest stamps the speaker onto EVERY fact — it left
    // the judge comparing an incoming profile against "(no facts)", for
    // every entity, forever. The entity being judged is already tenant-
    // global (the caller fenced it), so its facts are its evidence
    // whoever happened to state them.
    //
    // Edges ride along as `kind: other` lines. The extractor files the
    // same relation as a fact in one language and an edge in another, and
    // a judge that read only facts saw one side's employer and not the
    // other's.
    const [rows, edges] = await db.query<[R[], E[]]>(
      // confidence must be in the projection — SurrealDB 3.x requires the
      // ORDER BY idiom to appear in the SELECT (else "Missing order idiom").
      `SELECT predicate, object, confidence FROM knowledge_fact
         WHERE entityId = $eid
           AND status = 'active'
           AND retractedAt IS NONE
         ORDER BY confidence DESC
         LIMIT 5;
       SELECT kind, out.canonicalName AS other FROM knowledge_edge
         WHERE in = $eid
         LIMIT 5;`,
      { eid },
    );
    const lines = ((rows as R[]) ?? []).map((f) => `- ${f.predicate}: ${f.object}`);
    for (const e of (edges as E[]) ?? []) if (e.other) lines.push(`- ${e.kind}: ${e.other}`);
    if (lines.length === 0) return '(no facts)';
    return lines.join('\n');
  }

  /**
   * Decide whether the two fact-blocks describe the same entity. Runs under
   * the shared concurrency limiter. Returns "unsure" on any failure.
   *
   * @param left   rendered facts for side A (e.g. an existing entity)
   * @param right  rendered facts for side B (e.g. the incoming mention)
   * @param ctx.cosine optional name cosine-similarity hint for the prompt
   */
  async judge(left: string, right: string, ctx: JudgeContext = {}): Promise<EntityVerdict> {
    if (!this.openai) return 'unsure';
    try {
      return await this.limiter.run(() => this.callLLM(left, right, ctx));
    } catch (err) {
      this.logger.warn(`entity judge failed: ${(err as Error).message}`);
      return 'unsure';
    }
  }

  private async callLLM(left: string, right: string, ctx: JudgeContext): Promise<EntityVerdict> {
    const sys = `You decide whether two knowledge-graph entities are the SAME real-world thing or DIFFERENT things that happen to share a similar name.

The graph is multilingual. The two entities may have been mentioned in different languages, so their names may be two spellings of one name in two scripts, and their facts may say the same thing in two languages. A fact that is a translation of another fact is a MATCHING fact, not a contradiction: "employer: Orbital Dynamics" and "работодатель: Orbital Dynamics" agree; "role: lead architect" and "должность: ведущий архитектор" agree.

Use the facts as the evidence:
- "same" — facts directly identify them (matching dob / email / address / employer) OR facts are non-contradictory and the names are identical, clear aliases, or the same name written in two scripts.
- "different" — facts contradict (different dob / different email / different employer at the same time).
- "unsure" — the facts don't disambiguate either way (just names + occupation, common name).

When the facts genuinely do not disambiguate, prefer "different" — wrongly fusing two distinct entities is worse than a transient duplicate a later pass can still merge. But do not call two entities different because their facts are in different languages.

Output strictly the JSON shape requested. No preamble.`;
    const user = `Entity A:${nameLine(ctx.names?.a)}\n${left}\n\nEntity B:${nameLine(ctx.names?.b)}\n${right}${similarityLine(ctx)}`;

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
