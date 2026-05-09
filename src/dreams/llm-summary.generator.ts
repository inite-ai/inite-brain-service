import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import {
  FactToSummarize,
  SummaryGenerator,
} from '../compaction/summary-generator';

/**
 * LLM-backed SummaryGenerator. Drop-in for ConcatSummaryGenerator —
 * same interface, same call site (CompactionModule injects via the
 * SUMMARY_GENERATOR token).
 *
 * Concat-summary stitches facts into a chronological list. That
 * preserves traceability but loses the *insight* — "this customer
 * upgraded twice but downgraded after a complaint" is reconstructible
 * from a concat string only if the reader speaks fluent eval-runner.
 * The LLM-summary builds a 1-2 sentence high-level summary that the
 * search-time embedding can actually understand, while still citing
 * the original factIds in `derivedFrom` (set by the caller, not us).
 *
 * Falls back to concat behaviour on any error — the optional summary
 * leg of compaction must never break the actual mark-and-drop pass.
 *
 * Disabled by default; enable with DREAMS_LLM_SUMMARY_ENABLED=1. When
 * disabled, `generate` short-circuits to the concat fallback so
 * operators can flip the flag without re-deploying.
 */
@Injectable()
export class LlmSummaryGenerator implements SummaryGenerator {
  private readonly logger = new Logger(LlmSummaryGenerator.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly enabled: boolean;
  private readonly limiter: Semaphore;

  constructor(private readonly configService: ConfigService) {
    this.enabled =
      this.configService.get<string>('DREAMS_LLM_SUMMARY_ENABLED', '0') === '1';
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
      'DREAMS_SUMMARY_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('DREAMS_SUMMARY_CONCURRENCY', '4'),
        10,
      ),
    );
  }

  async generate(group: FactToSummarize[]): Promise<string> {
    if (group.length === 0) return '';
    if (!this.enabled || !this.openai) {
      return this.concatFallback(group);
    }
    try {
      const summary = await this.limiter.run(() => this.callLLM(group));
      if (summary) return summary;
      return this.concatFallback(group);
    } catch (err) {
      this.logger.warn(
        `LLM summary failed (${group.length} facts): ${(err as Error).message}`,
      );
      return this.concatFallback(group);
    }
  }

  private async callLLM(group: FactToSummarize[]): Promise<string> {
    const sys = `You are a knowledge-graph summarizer.

Given a chronological list of facts about ONE entity (sharing the same predicate), produce ONE concise summary sentence (≤ 200 chars) that captures the high-level trajectory or pattern, NOT a verbatim list.

Rules:
- Use ONLY information present in the facts. Do not speculate or invent context.
- Reference specific dates / values when relevant (e.g. "upgraded from gold to platinum in April 2026").
- If the facts represent a single repeated theme without a meaningful trajectory, summarise the theme + frequency ("complained 4× about parking between Feb and May 2026").
- Prefer the dominant pattern: a tier upgrade followed by a downgrade is "tier oscillated", not "tier was platinum".
- Output the summary string ONLY, no JSON, no quotes, no preamble.`;
    const lines = group
      .map((f) => `[${f.validFrom.slice(0, 10)}] ${f.predicate}: ${f.object}`)
      .join('\n');
    const user = `Facts (chronological):\n${lines}`;

    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      max_completion_tokens: 200,
      temperature: 0,
    });
    const content = res.choices[0]?.message?.content?.trim();
    if (!content) return '';
    // Defensive cap — LLMs occasionally over-write past the prompt
    // limit despite max_completion_tokens.
    return content.length > 400 ? content.slice(0, 397) + '...' : content;
  }

  private concatFallback(group: FactToSummarize[]): string {
    const parts = group.map((f) => {
      const day = f.validFrom.slice(0, 10);
      return `[${day}] ${f.predicate}: ${f.object}`;
    });
    const text = parts.join(' | ');
    const MAX = 8_000;
    return text.length <= MAX ? text : text.slice(0, MAX - 3) + '...';
  }
}
