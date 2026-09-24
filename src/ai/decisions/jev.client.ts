import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Semaphore } from '../../common/semaphore';
import { withGenAiCall } from '../../common/gen-ai-observability';
import { getAbortSignal } from '../../common/request-context';
import { MetricsService } from '../../metrics/metrics.service';
import type { DecisionRequest, DecisionResponse, DecisionAnswer } from './decision.types';

/**
 * TypeSafe Jev — the System One model behind the decision plane.
 *
 * One HTTP endpoint (`POST <base>/v1/systemone`), one request per state, every
 * question answered in parallel against it.
 *
 * The base is a knob because the same protocol is served from two places: the
 * vendor (`https://api.typesafe.ai`) and OpenRouter
 * (`https://openrouter.ai/api`), which proxies the Decisions protocol verbatim
 * and bills it to the OpenRouter account — one key instead of two. OpenRouter
 * also returns `id`, `provider` and `usage.cost`; the cost is the actual money
 * a decision spent, so it goes on the span rather than being dropped. Billing is input-only, so the
 * shape that would be extravagant on a chat model — ask ten questions at once,
 * give every choice a described option — is the cheap shape here.
 *
 * What this client owns and the callers must not re-invent: the retry policy
 * (429 rate limit / 529 overloaded are retried with backoff; 4xx are not), the
 * concurrency cap, the timeout, and the response-shape check. A malformed or
 * partial answer map returns null rather than a guess — a decision plane that
 * invents a decision is worse than one that abstains.
 */
@Injectable()
export class JevClient {
  private readonly logger = new Logger(JevClient.name);
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly limiter: Semaphore;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.apiKey = config.get<string>('TYPESAFE_API_KEY') || undefined;
    this.baseUrl = (config.get<string>('TYPESAFE_BASE_URL') ?? 'https://api.typesafe.ai').replace(
      /\/$/,
      '',
    );
    this.model = config.get<string>('TYPESAFE_MODEL', 'jev-latest');
    this.timeoutMs = parseInt(config.get<string>('TYPESAFE_TIMEOUT_MS', '10000'), 10);
    this.maxRetries = parseInt(config.get<string>('TYPESAFE_MAX_RETRIES', '3'), 10);
    this.limiter = new Semaphore(parseInt(config.get<string>('TYPESAFE_CONCURRENCY', '16'), 10));
  }

  /** Whether the plane can run at all — no key, no decisions. */
  available(): boolean {
    return this.apiKey !== undefined && this.apiKey !== '';
  }

  modelId(): string {
    return this.model;
  }

  /**
   * Ask one state a map of questions. Returns null when the plane is
   * unconfigured, the call fails after its retries, or the answer map does not
   * carry every question that was asked — the caller then falls back.
   */
  async decide(req: DecisionRequest, lane: string): Promise<DecisionResponse | null> {
    if (!this.available()) return null;
    const asked = Object.keys(req.questions);
    if (asked.length === 0) return null;

    try {
      const decorated = await this.limiter.run(() =>
        withGenAiCall(
          {
            kind: 'chat',
            spanName: `gen_ai.decide.${lane}`,
            system: 'typesafe',
            model: this.model,
            attrs: { 'decision.lane': lane, 'decision.questions': asked.length },
          },
          this.metrics,
          async () => {
            const res = await this.post(req);
            // The observability wrapper reads OpenAI-shaped usage; Jev names
            // the same two numbers differently. The shim lives on the value
            // the WRAPPER sees, never on the response a lane gets back.
            return Object.assign(res, {
              usage: {
                ...res.usage,
                prompt_tokens: res.usage.inputTokens,
                completion_tokens: res.usage.outputTokens,
              },
            });
          },
        ),
      );
      return {
        model: decorated.model,
        answers: decorated.answers,
        usage: {
          inputTokens: decorated.usage.inputTokens,
          outputTokens: decorated.usage.outputTokens,
          ...(decorated.usage.cost !== undefined ? { cost: decorated.usage.cost } : {}),
        },
      };
    } catch (err) {
      this.logger.warn(`[decide.${lane}] ${(err as Error).message}`);
      return null;
    }
  }

  private async post(req: DecisionRequest): Promise<DecisionResponse> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const timer = AbortSignal.timeout(this.timeoutMs);
      const caller = getAbortSignal();
      const signal = caller ? AbortSignal.any([timer, caller]) : timer;
      let status = 0;
      try {
        const res = await fetch(`${this.baseUrl}/v1/systemone`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: this.model, state: req.state, questions: req.questions }),
          signal,
        });
        status = res.status;
        if (res.ok) return this.parse(await res.json(), Object.keys(req.questions));
        const body = await res.text().catch(() => '');
        lastErr = new Error(`jev ${status}: ${body.slice(0, 200)}`);
        // 401 invalid key, 422 malformed request — retrying changes nothing.
        if (status !== 429 && status !== 529 && status < 500) throw lastErr;
      } catch (err) {
        lastErr = err as Error;
        if (caller?.aborted) throw lastErr;
        if (status !== 0 && status !== 429 && status !== 529 && status < 500) throw lastErr;
      }
      if (attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw lastErr ?? new Error('jev: no response');
  }

  /**
   * Shape check. Every question asked must come back with an answer of the
   * shape its primitive promises — a half-filled map means the lane has to
   * fall back, not pick over what arrived.
   */
  private parse(raw: unknown, asked: string[]): DecisionResponse {
    const body = raw as {
      model?: unknown;
      answers?: Record<string, unknown>;
      usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown };
    };
    const answers: Record<string, DecisionAnswer> = {};
    for (const key of asked) {
      const a = body.answers?.[key] as Record<string, unknown> | undefined;
      if (!a || typeof a !== 'object') throw new Error(`jev: no answer for "${key}"`);
      if (a['type'] === 'noul' && typeof a['noul'] === 'number') {
        answers[key] = { type: 'noul', noul: a['noul'] };
      } else if (
        a['type'] === 'choice' &&
        typeof a['choice'] === 'string' &&
        typeof a['confidence'] === 'number'
      ) {
        answers[key] = {
          type: 'choice',
          choice: a['choice'],
          probabilities: (a['probabilities'] ?? {}) as Record<string, number>,
          confidence: a['confidence'],
        };
      } else if (
        a['type'] === 'score' &&
        typeof a['score'] === 'number' &&
        typeof a['confidence'] === 'number'
      ) {
        answers[key] = {
          type: 'score',
          score: a['score'],
          legend: (a['legend'] ?? {}) as Record<string, string>,
          probabilities: (a['probabilities'] ?? {}) as Record<string, number>,
          confidence: a['confidence'],
        };
      } else {
        throw new Error(`jev: unusable answer for "${key}"`);
      }
    }
    const cost = body.usage?.cost;
    return {
      model: typeof body.model === 'string' ? body.model : this.model,
      answers,
      usage: {
        inputTokens: Number(body.usage?.input_tokens ?? 0),
        outputTokens: Number(body.usage?.output_tokens ?? 0),
        ...(typeof cost === 'number' ? { cost } : {}),
      },
    };
  }
}
