import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { traceArtifact } from '../common/debug-trace';
import { withGenAiCall } from '../common/gen-ai-observability';
import { MetricsService } from '../metrics/metrics.service';
import { buildSchema, buildSystemPrompt } from './chat-router-internals/prompts';
import { extractJsonObject } from './chat-router-internals/validator';
import type { RawRouteOutput } from './chat-router-internals/types';
import type { RouteContext } from './chat-route-context';

export type LlmRouteResult =
  | { kind: 'parsed'; parsed: RawRouteOutput }
  | { kind: 'parse_error'; message: string }
  | { kind: 'llm_error'; message: string }
  | null;

/**
 * LLM-call stage of the chat router: one grounded OpenAI completion that
 * returns STRUCTURED EDIT OPERATIONS + SPAN-ANCHORED slots (never a free-text
 * rewrite). Owns the OpenAI client + model config and the gen-ai observability
 * wrapper. Two deps (config / metrics).
 */
@Injectable()
export class ChatRouterLlmService {
  private readonly logger = new Logger(ChatRouterLlmService.name);
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
      // Honour the same OPENAI_TIMEOUT_MS / OPENAI_MAX_RETRIES knobs every
      // other OpenAI-using service reads — this was the sole outlier
      // hardcoding 15s/1, so an operator raising the timeout silently
      // didn't apply to chat routing.
      timeout: parseInt(this.config.get<string>('OPENAI_TIMEOUT_MS', '30000'), 10),
      maxRetries: parseInt(this.config.get<string>('OPENAI_MAX_RETRIES', '3'), 10),
    });
    this.model = this.config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
  }

  async call(message: string, ctx: RouteContext): Promise<LlmRouteResult> {
    const system = buildSystemPrompt(ctx.predicateVocab, ctx.knownNames);
    const user = `now: ${ctx.nowIso}
message: ${message}`;
    traceArtifact('demo.chat.prompt', {
      system,
      user,
      model: this.model,
      registryVersionHash: ctx.snapshot?.versionHash ?? 'unavailable',
      predicateCount: ctx.predicateVocab.length,
      knownNamesCount: ctx.knownNames.length,
    });
    let res: Awaited<ReturnType<typeof this.openai.chat.completions.create>>;
    try {
      res = await withGenAiCall(
        {
          kind: 'chat',
          spanName: 'gen_ai.chat.chat_router',
          system: 'openai',
          model: this.model,
        },
        this.metrics,
        () =>
          this.openai.chat.completions.create({
            model: this.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'chat_route',
                strict: true,
                schema: buildSchema(ctx.predicateVocab),
              },
            },
            temperature: 0,
            max_completion_tokens: 800,
          }),
      );
    } catch (e) {
      // OpenAI network glitch (Premature close, ETIMEDOUT, 5xx after
      // SDK retries exhausted) MUST NOT bubble up as a 500 to the
      // demo client. The caller checks `kind: 'llm_error'` and falls
      // back to a safeDefault route — the chat UI still gets a
      // response, the trace records why we degraded.
      const msg = (e as Error).message;
      this.logger.warn(
        `chat router LLM call failed: ${msg}; falling back to safeDefault`,
      );
      traceArtifact('demo.chat.llm_error', { message: msg });
      return { kind: 'llm_error', message: msg };
    }
    const content = res.choices[0]?.message?.content;
    const finish = res.choices[0]?.finish_reason;
    traceArtifact('demo.chat.raw', { content, finish_reason: finish });
    if (!content) return null;
    try {
      const parsed = JSON.parse(extractJsonObject(content)) as RawRouteOutput;
      return { kind: 'parsed', parsed };
    } catch (e) {
      this.logger.warn(
        `chat router parse failed: ${(e as Error).message}; raw="${content.slice(0, 200)}"`,
      );
      return { kind: 'parse_error', message: (e as Error).message };
    }
  }
}
