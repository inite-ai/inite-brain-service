import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import { EmbedderService } from './embedder.service';

/**
 * HyPE — Hypothetical Prompt Embeddings.
 *
 * For each ingested fact, generate a single hypothetical question
 * the fact would answer ("who reported a broken washing machine?"
 * for `complained_about: broken washing machine`), embed it, and
 * store alongside the main object embedding. At search time the
 * vector leg takes max(cosine(main, q), cosine(alt, q)) — closing
 * the question→statement gap that pure object-text embeddings
 * cannot bridge.
 *
 * Disabled by default; enable with SEARCH_HYPE_ENABLED=1. When
 * disabled, ingest skips the extra LLM call and `altEmbedding`
 * stays NONE — search degrades cleanly to the cosine-on-object
 * shape it had before.
 */
@Injectable()
export class HypeService {
  private readonly logger = new Logger(HypeService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly enabled: boolean;
  private readonly limiter: Semaphore;

  constructor(
    private readonly configService: ConfigService,
    private readonly embedder: EmbedderService,
  ) {
    this.enabled =
      this.configService.get<string>('SEARCH_HYPE_ENABLED', '0') === '1';
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
      'SEARCH_HYPE_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('SEARCH_HYPE_CONCURRENCY', '4'),
        10,
      ),
    );
  }

  isEnabled(): boolean {
    return this.enabled && !!this.openai;
  }

  /**
   * Generate one hypothetical-question embedding for `(predicate, object)`.
   * Returns null when disabled, when the LLM call fails, or when the
   * generated question is empty — the caller (ingest) treats null as
   * "no alt embedding, skip the column".
   */
  async generateAltEmbedding(
    predicate: string,
    object: string,
  ): Promise<number[] | null> {
    if (!this.isEnabled()) return null;
    if (!object.trim()) return null;

    let question: string;
    try {
      question = await this.limiter.run(() => this.askForQuestion(predicate, object));
    } catch (err) {
      this.logger.warn(
        `HyPE question generation failed (predicate=${predicate}): ${(err as Error).message}`,
      );
      return null;
    }
    if (!question) return null;

    try {
      return await this.embedder.embed(question);
    } catch (err) {
      this.logger.warn(`HyPE embedding failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async askForQuestion(predicate: string, object: string): Promise<string> {
    const sys = `You generate a single concise natural-language question that this knowledge-graph fact would directly answer. Output ONLY the question, no extras, no quotes.

The question should:
- Be in the form a user would type into a search bar (≤12 words).
- Sit in the same semantic space as a free-text query, not the underlying database row.
- Reference the predicate's intent (a complaint → "who has issues with…", an intent → "who wants…", a name → "who is…", a tier → "who is on tier…").
- Avoid copying the object text verbatim — paraphrase so the embedding diverges from the literal-object embedding.`;
    const user = `predicate: ${predicate}\nobject: ${object}`;

    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'hyp_question',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question: { type: 'string' },
            },
            required: ['question'],
          },
        },
      },
      max_completion_tokens: 80,
      temperature: 0,
    });
    const content = res.choices[0]?.message?.content;
    if (!content) return '';
    try {
      const parsed = JSON.parse(content);
      const q = typeof parsed.question === 'string' ? parsed.question.trim() : '';
      return q;
    } catch {
      return '';
    }
  }
}
