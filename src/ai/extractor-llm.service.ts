import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClientOrThrow } from './openai-client';
import { Semaphore } from '../common/semaphore';
import { withGenAiCall } from '../common/gen-ai-observability';
import { getAbortSignal } from '../common/request-context';
import { MetricsService } from '../metrics/metrics.service';
import { PredicateDefinition } from './predicate-registry.service';
import type { PackExtractionProfile } from './predicate-registry-internals/types';
import {
  EXTRACTION_PROMPT_HEADER,
  buildExtractionSchema,
  buildSystemPrompt,
  buildDialogueSystemPrompt,
  renderExtractionProfiles,
  renderPredicateCard,
} from './extractor-internals/prompts';
import { objectNormalizationEnabled } from './extractor-internals/grounding';
import { resolveExtractionProfile } from './extraction-profile';

/**
 * ExtractorLlmService — the OpenAI I/O slice of the extractor: the chat
 * client, the system-prompt assembly from the predicate snapshot, and
 * the self-consistency pass count. Owns config (client + tuning) and
 * metrics; the orchestration/assembly live in ExtractorRunnerService.
 * Splitting it out keeps each extractor class ≤3 injected deps.
 */
@Injectable()
export class ExtractorLlmService {
  private readonly logger = new Logger(ExtractorLlmService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly systemPromptHeader: string;
  private readonly limiter: Semaphore;
  /** Self-consistency / N-pass driver count (1 = single-pass). */
  readonly scPasses: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.openai = createOpenAiClientOrThrow(this.configService);
    this.model = this.configService.get<string>(
      'OPENAI_CHAT_MODEL',
      'gpt-4o-mini',
    );
    // The static EXTRACTION_SYSTEM_PROMPT override is no longer the
    // source of truth for vocabulary — that's the registry. The env
    // var stays as an escape hatch for operators who want to fully
    // replace the prompt header (everything before the dynamically-
    // rendered predicate cards).
    this.systemPromptHeader =
      this.configService.get<string>('EXTRACTION_SYSTEM_PROMPT') ??
      EXTRACTION_PROMPT_HEADER;
    this.limiter = new Semaphore(
      parseInt(this.configService.get<string>('OPENAI_CONCURRENCY', '8'), 10),
    );
    this.scPasses = Math.max(
      1,
      parseInt(this.configService.get<string>('EXTRACTOR_SC_PASSES', '1'), 10),
    );
  }

  /** Identity of the extraction model — used as the default source.recorder. */
  modelId(): string {
    return this.model;
  }

  composeSystemPrompt(snapshot: {
    active: PredicateDefinition[];
    extractionProfiles?: PackExtractionProfile[];
  }): string {
    // Phase 4 dialogue profile: swap the closed-vocab/verbatim header for the
    // open/normalized one. Only when the operator hasn't pinned a custom header
    // via EXTRACTION_SYSTEM_PROMPT (that escape hatch still wins). Off →
    // byte-identical to before.
    const dialogue =
      this.systemPromptHeader === EXTRACTION_PROMPT_HEADER &&
      resolveExtractionProfile().vocabulary === 'open';
    const base = dialogue
      ? buildDialogueSystemPrompt(snapshot.active)
      : this.systemPromptHeader === EXTRACTION_PROMPT_HEADER
        ? buildSystemPrompt(snapshot.active, {
            objectNormalization: this.objectNormalizationActive(),
          })
        : this.systemPromptHeader +
          snapshot.active.map(renderPredicateCard).join('\n');
    return base + renderExtractionProfiles(snapshot.extractionProfiles ?? []);
  }

  /**
   * EXTRACTION_OBJECT_NORMALIZE is only meaningful on the span-grounded
   * general profile: the dialogue profile normalizes through its own
   * contract, and a pinned custom header (EXTRACTION_SYSTEM_PROMPT)
   * would not explain the extra schema field to the model.
   */
  private objectNormalizationActive(): boolean {
    return (
      this.systemPromptHeader === EXTRACTION_PROMPT_HEADER &&
      objectNormalizationEnabled(resolveExtractionProfile())
    );
  }

  /**
   * One extraction chat call. `model` overrides the process-global
   * OPENAI_CHAT_MODEL for THIS call — dedicated indexer runs may pin a
   * bigger model per pack (IndexerDescriptor.dedicated.model) without
   * touching the union path's config.
   */
  async callLlm(args: {
    trimmed: string;
    systemPrompt: string;
    temperature?: number | undefined;
    model?: string | undefined;
    /**
     * Per-turn speaker framing prepended to the user message (see
     * buildConversationContext). Grounding still runs against `trimmed`
     * alone, so the prefix drives coreference without polluting valueSpan
     * containment. Empty/absent → byte-identical to the pre-coreference call.
     */
    contextPrefix?: string | undefined;
  }): Promise<unknown> {
    const { trimmed, systemPrompt } = args;
    const temperature = args.temperature ?? 0.1;
    const model = args.model ?? this.model;
    const userContent = (args.contextPrefix ?? '') + trimmed;
    const res = await this.limiter.run(() =>
      withGenAiCall(
        {
          kind: 'chat',
          spanName: 'gen_ai.chat.extractor',
          system: 'openai',
          model,
          attrs: { 'gen_ai.request.temperature': temperature },
        },
        this.metrics,
        () =>
          this.openai.chat.completions.create(
            {
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
              ],
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'extraction',
                  strict: true,
                  // Schema and prompt section move in lockstep — the
                  // object field only exists when the prompt explains it.
                  schema: buildExtractionSchema({
                    objectNormalization: this.objectNormalizationActive(),
                  }),
                },
              },
              max_completion_tokens: 1500,
              temperature,
            },
            { signal: getAbortSignal() },
          ),
      ),
    );
    const content = res.choices[0]?.message?.content;
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch (err) {
      this.logger.warn(`Extractor returned non-JSON: ${(err as Error).message}`);
      return null;
    }
  }
}
