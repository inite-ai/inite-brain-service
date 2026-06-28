import { Injectable, Logger } from '@nestjs/common';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { clampLlmInputText } from '../common/input-limits';
import { ChatRouterCacheService } from './chat-router-cache.service';
import { ChatRoutePlannerService } from './chat-route-planner.service';
import { ChatRouterLlmService } from './chat-router-llm.service';
import type { ChatRoute, RawRouteOutput } from './chat-router-internals/types';
import { shouldSkipLLM } from './chat-router-internals/local-prepass';
import { validateAndAssemble } from './chat-router-internals/validator';
import type { RouteContext, RoutePlan } from './chat-route-context';

export type {
  ChatRoute,
  Span,
  EditOp,
  TemporalAnchor,
  ValidationReport,
} from './chat-router-internals/types';
export {
  classifyIntentLocally,
  extractPredicateHintsLocally,
  shouldSkipLLM,
} from './chat-router-internals/local-prepass';

/**
 * Grounded chat router for the brain demo.
 *
 * Architectural rule: every output field that drives downstream
 * behaviour MUST be grounded in the user message via deterministic
 * server-side validation. The LLM never emits a free-text rewrite or
 * a "default" timestamp — instead it returns STRUCTURED EDIT
 * OPERATIONS and SPAN-ANCHORED slots, all of which the server
 * validates by checking that the claimed substring actually appears
 * in the input.
 *
 * Pipeline stages, each its own service:
 *   1. Local pre-pass — {@link ChatRoutePlannerService} (chrono temporal,
 *      lexical mention resolve, embedding predicate hints, collapse-pattern
 *      lookup, NLI intent).
 *   2. Skip gate (`local-prepass.ts:shouldSkipLLM`) — synthesise the route
 *      from locals when every slot is confident, no LLM round-trip.
 *   3. LLM call — {@link ChatRouterLlmService} (prompt + JSON schema; one
 *      OpenAI call).
 *   4. Local-override merge (this file) — chrono/lexical/embedding override
 *      the LLM's matching slots.
 *   5. Validate + assemble (`./chat-router-internals/validator.ts`).
 *   6. Cache write ({@link ChatRouterCacheService}) + collapse-pattern teach
 *      (planner).
 */
@Injectable()
export class ChatRouterService {
  private readonly logger = new Logger(ChatRouterService.name);
  private readonly intentConfidenceFloor = cfgFloat(
    'CHAT_ROUTE_INTENT_CONFIDENCE_FLOOR',
    0.85,
  );

  constructor(
    private readonly planner: ChatRoutePlannerService,
    private readonly llm: ChatRouterLlmService,
    private readonly routeCache: ChatRouterCacheService,
  ) {}

  async route(
    message: string,
    options: { knownNames?: string[]; now?: Date; companyId: string },
  ): Promise<ChatRoute> {
    // Defence-in-depth clamp — admin-demo body shapes bypass the
    // DTO-level @MaxLength. Chat-router fans out to both the
    // extractor (16K cap) and search (8K cap); use the tighter of
    // the two since `message` is conversational.
    const clamped = clampLlmInputText(message ?? '', 'query');
    if (clamped.truncated) {
      this.logger.warn(
        `chat-router: message truncated to ${clamped.value.length} chars (companyId=${options.companyId})`,
      );
    }
    message = clamped.value;
    const ctx = await this.buildRouteContext(message, options);

    // Cache hit: replay a validated route with byte-identical spans.
    const cached = this.routeCache.get(ctx.cacheKey);
    if (cached) {
      traceArtifact('demo.chat.cache_decision', {
        hit: true,
        key: ctx.cacheKey,
        hasTemporal: ctx.localTemporal !== null,
      });
      return cached;
    }
    traceArtifact('demo.chat.cache_decision', {
      hit: false,
      key: ctx.cacheKey,
      hasTemporal: ctx.localTemporal !== null,
    });

    return traceSpan('demo.chat.route', () => this.routeMiss(message, ctx));
  }

  // ── Per-request setup: local pre-pass (planner) + cache key ──
  private async buildRouteContext(
    message: string,
    options: { knownNames?: string[]; now?: Date; companyId: string },
  ): Promise<RouteContext> {
    const plan: RoutePlan = await this.planner.buildContext(message, options);
    const cacheKey = this.routeCache.computeKey({
      companyId: plan.companyId,
      message,
      knownNames: plan.knownNames,
      predicateVocab: plan.predicateVocab,
      hasTemporal: plan.localTemporal !== null,
      now: options.now ?? new Date(),
    });
    return { ...plan, cacheKey };
  }

  // ── Cache-miss path: skip gate vs LLM call → validate → cache ──
  private async routeMiss(
    message: string,
    ctx: RouteContext,
  ): Promise<ChatRoute> {
    const skipDecision = shouldSkipLLM({
      intent: ctx.localIntent.intent,
      intentConfidence: ctx.localIntent.confidence,
      localMentions: ctx.localMentions,
      localHints: ctx.localHints,
      localCollapses: ctx.localCollapses,
      intentConfidenceFloor: this.intentConfidenceFloor,
    });
    traceArtifact('demo.chat.skip_decision', {
      ...skipDecision,
      intent: ctx.localIntent.intent,
      intentConfidence: ctx.localIntent.confidence,
      intentSource: ctx.localIntent.source,
      intentConfidenceFloor: this.intentConfidenceFloor,
    });

    if (skipDecision.skip) {
      const synthetic = this.buildSyntheticRoute(ctx, skipDecision.reason);
      const route = validateAndAssemble({
        message,
        parsed: synthetic,
        vocab: new Set(ctx.predicateVocab),
        knownNames: new Set(ctx.knownNames),
      });
      this.routeCache.set(ctx.cacheKey, route);
      return route;
    }

    const llmOut = await this.llm.call(message, ctx);
    if (!llmOut) {
      return this.safeDefault(message, 'router-empty');
    }
    if (llmOut.kind === 'parse_error') {
      return this.safeDefault(message, `router-parse: ${llmOut.message}`);
    }
    if (llmOut.kind === 'llm_error') {
      return this.safeDefault(message, `router-llm: ${llmOut.message}`);
    }

    const merged = this.mergeLlmWithLocals(llmOut.parsed, ctx);
    const route = validateAndAssemble({
      message,
      parsed: merged,
      vocab: new Set(ctx.predicateVocab),
      knownNames: new Set(ctx.knownNames),
    });
    this.routeCache.set(ctx.cacheKey, route);

    void this.planner.teachCollapsePatterns(message, ctx, llmOut.parsed);
    return route;
  }

  private buildSyntheticRoute(
    ctx: RouteContext,
    skipReason: string,
  ): RawRouteOutput {
    return {
      intent: ctx.localIntent.intent,
      mentions: ctx.localMentions.map((m) => ({
        canonical: m.canonical,
        nameSpan: m.span,
      })),
      predicateHints:
        ctx.localIntent.intent === 'ask'
          ? ctx.localHints.map((h) => ({
              predicateId: h.predicateId,
              triggerSpan: h.triggerSpan,
            }))
          : [],
      edits: ctx.localCollapses.map((c) => ({
        op: 'collapse_state_change' as const,
        sourceSpan: c.span,
        canonical: null,
        replacement: c.replacement,
      })),
      asOf:
        ctx.localIntent.intent === 'ask' && ctx.localTemporal
          ? { iso: ctx.localTemporal.iso, anchorSpan: ctx.localTemporal.span }
          : null,
      validFrom:
        ctx.localIntent.intent === 'tell' && ctx.localTemporal
          ? { iso: ctx.localTemporal.iso, anchorSpan: ctx.localTemporal.span }
          : null,
      reason: `local-skip (${skipReason})`,
    };
  }

  /**
   * Override the LLM's slots with local-pre-pass results where they
   * fired — chrono is faster + multilingual + deterministic, lexical
   * mention match is sub-ms + always correct against the whitelist.
   * Predicate hints UNION (LLM + local) since the embedding pass is
   * not exhaustive against the registry. Collapse edits prepend the
   * locals so the validator's overlap-dedup wins ties for them.
   */
  private mergeLlmWithLocals(
    parsed: RawRouteOutput,
    ctx: RouteContext,
  ): RawRouteOutput {
    const merged: RawRouteOutput = { ...parsed };
    if (ctx.localMentions.length > 0) {
      merged.mentions = ctx.localMentions.map((m) => ({
        canonical: m.canonical,
        nameSpan: m.span,
      }));
    }
    if (parsed.intent === 'ask' && ctx.localTemporal) {
      merged.asOf = {
        iso: ctx.localTemporal.iso,
        anchorSpan: ctx.localTemporal.span,
      };
    } else if (parsed.intent === 'tell' && ctx.localTemporal) {
      merged.validFrom = {
        iso: ctx.localTemporal.iso,
        anchorSpan: ctx.localTemporal.span,
      };
    }
    if (parsed.intent === 'ask' && ctx.localHints.length > 0) {
      const llmHints = parsed.predicateHints ?? [];
      const localIds = new Set(ctx.localHints.map((h) => h.predicateId));
      merged.predicateHints = [
        ...ctx.localHints.map((h) => ({
          predicateId: h.predicateId,
          triggerSpan: h.triggerSpan,
        })),
        ...llmHints.filter((h) => !localIds.has(h.predicateId)),
      ];
    }
    if (ctx.localCollapses.length > 0) {
      merged.edits = [
        ...ctx.localCollapses.map((c) => ({
          op: 'collapse_state_change' as const,
          sourceSpan: c.span,
          canonical: null,
          replacement: c.replacement,
        })),
        ...(parsed.edits ?? []),
      ];
    }
    return merged;
  }

  /** Safe default when the LLM gave us nothing usable. Treat as a tell
   *  of the original message — ingest still happens, downstream
   *  pipeline doesn't 500. */
  private safeDefault(message: string, reason: string): ChatRoute {
    this.logger.warn(`chat router defaulting: ${reason}`);
    return {
      intent: 'tell',
      normalizedMessage: message,
      mentions: [],
      predicateHints: [],
      reason,
    };
  }
}

function cfgFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
