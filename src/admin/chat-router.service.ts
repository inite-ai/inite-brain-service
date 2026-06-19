import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import {
  PredicateRegistryService,
  type PredicateSnapshot,
} from '../ai/predicate-registry.service';
import { EmbedderService } from '../ai/embedder.service';
import { ChatRouterCacheService } from './chat-router-cache.service';
import {
  CollapsePatternService,
  extractCollapseEditsLocally,
} from './collapse-pattern.service';
import { IntentClassifierService } from './intent-classifier.service';

import type { ChatRoute, RawRouteOutput } from './chat-router-internals/types';
import { buildSchema, buildSystemPrompt } from './chat-router-internals/prompts';
import {
  extractMentionsLocally,
  extractPredicateHintsLocally,
  extractTemporalLocally,
  shouldSkipLLM,
} from './chat-router-internals/local-prepass';
import {
  extractJsonObject,
  nfc,
  validateAndAssemble,
  validateSpan,
} from './chat-router-internals/validator';

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
 * Pipeline stages — each lives in its own module under
 * `./chat-router-internals/`:
 *   1. Local pre-pass (`local-prepass.ts`) — chrono temporal extract,
 *      lexical mention resolve, embedding-based predicate hints,
 *      collapse-pattern cache lookup, NLI intent classification.
 *   2. Skip gate (`local-prepass.ts:shouldSkipLLM`) — if every local
 *      slot is confident, synthesise the RawRouteOutput from locals
 *      and run validation without the LLM round-trip.
 *   3. LLM call (this file) — prompt + JSON schema in
 *      `./chat-router-internals/prompts.ts`; one OpenAI call.
 *   4. Local-override merge (this file) — chrono/lexical/embedding
 *      results override or augment the LLM's matching slots.
 *   5. Validate + assemble (`./chat-router-internals/validator.ts`) —
 *      grounding checks, edit application, ChatRoute build.
 *   6. Cache write + collapse-pattern teach (this file).
 */
@Injectable()
export class ChatRouterService {
  private readonly logger = new Logger(ChatRouterService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly hintSimilarityThreshold: number;
  private readonly hintMaxCount: number;
  private readonly intentConfidenceFloor: number;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: PredicateRegistryService,
    private readonly routeCache: ChatRouterCacheService,
    private readonly embedder: EmbedderService,
    private readonly collapsePatterns: CollapsePatternService,
    private readonly intentClassifier: IntentClassifierService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: 15_000,
      maxRetries: 1,
    });
    this.model = this.config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
    this.hintSimilarityThreshold = parseFloat(
      this.config.get<string>('CHAT_ROUTE_HINT_SIMILARITY', '0.4'),
    );
    this.hintMaxCount = parseInt(
      this.config.get<string>('CHAT_ROUTE_HINT_MAX', '3'),
      10,
    );
    this.intentConfidenceFloor = parseFloat(
      this.config.get<string>('CHAT_ROUTE_INTENT_CONFIDENCE_FLOOR', '0.85'),
    );
  }

  async route(
    message: string,
    options: { knownNames?: string[]; now?: Date; companyId: string },
  ): Promise<ChatRoute> {
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

  // ── Per-request setup: local pre-pass + cache key + skip decision ──
  private async buildRouteContext(
    message: string,
    options: { knownNames?: string[]; now?: Date; companyId: string },
  ): Promise<RouteContext> {
    const knownNames = options.knownNames ?? [];
    const nowIso = (options.now ?? new Date()).toISOString();
    const refDate = options.now ?? new Date();

    const snapshot = await this.loadPredicateSnapshot(options.companyId);
    const predicateVocab = snapshot?.active.map((p) => p.predicateId) ?? [];

    const localTemporal = extractTemporalLocally(message, refDate);
    const localMentions = extractMentionsLocally(message, knownNames);
    traceArtifact('demo.chat.local_planner', {
      temporal: localTemporal,
      mentions: localMentions,
      knownNamesCount: knownNames.length,
    });

    const cacheKey = this.routeCache.computeKey({
      companyId: options.companyId,
      message,
      knownNames,
      predicateVocab,
      hasTemporal: localTemporal !== null,
      now: refDate,
    });

    const localHints = await extractPredicateHintsLocally(
      message,
      snapshot,
      this.embedder,
      this.hintSimilarityThreshold,
      this.hintMaxCount,
    );
    traceArtifact('demo.chat.local_hints', {
      hints: localHints,
      threshold: this.hintSimilarityThreshold,
      poolSize: snapshot?.embeddings.size ?? 0,
    });

    const { collapseSnapshot, localCollapses } = await this.loadCollapseSnapshot(
      message,
      options.companyId,
    );
    traceArtifact('demo.chat.local_collapses', {
      hits: localCollapses,
      poolSize: collapseSnapshot?.patterns.size ?? 0,
    });

    const localIntent = await this.intentClassifier.classify(message);
    traceArtifact('demo.chat.local_intent', {
      intent: localIntent.intent,
      confidence: localIntent.confidence,
      source: localIntent.source,
    });

    return {
      companyId: options.companyId,
      knownNames,
      snapshot,
      predicateVocab,
      nowIso,
      cacheKey,
      localTemporal,
      localMentions,
      localHints,
      localCollapses,
      collapseSnapshot,
      localIntent,
    };
  }

  private async loadPredicateSnapshot(
    companyId: string,
  ): Promise<PredicateSnapshot | null> {
    try {
      return await this.registry.getSnapshot(companyId);
    } catch (e) {
      this.logger.warn(
        `chat router: registry getSnapshot failed for ${companyId}: ${(e as Error).message}; falling back to permissive vocab`,
      );
      return null;
    }
  }

  private async loadCollapseSnapshot(
    message: string,
    companyId: string,
  ): Promise<{
    collapseSnapshot:
      | { patterns: Map<string, { pattern: string; replacement: string }> }
      | null;
    localCollapses: ReturnType<typeof extractCollapseEditsLocally>;
  }> {
    try {
      const snapshot = await this.collapsePatterns.getSnapshot(companyId);
      return {
        collapseSnapshot: snapshot,
        localCollapses: extractCollapseEditsLocally(message, snapshot),
      };
    } catch (e) {
      this.logger.warn(
        `collapse-pattern snapshot failed for ${companyId}: ${(e as Error).message}; LLM-only collapse`,
      );
      return { collapseSnapshot: null, localCollapses: [] };
    }
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
      const route = validateAndAssemble(
        message,
        synthetic,
        new Set(ctx.predicateVocab),
        new Set(ctx.knownNames),
      );
      this.routeCache.set(ctx.cacheKey, route);
      return route;
    }

    const llmOut = await this.callRouterLlm(message, ctx);
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
    const route = validateAndAssemble(
      message,
      merged,
      new Set(ctx.predicateVocab),
      new Set(ctx.knownNames),
    );
    this.routeCache.set(ctx.cacheKey, route);

    void this.teachCollapsePatterns(message, ctx, llmOut.parsed);
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

  private async callRouterLlm(
    message: string,
    ctx: RouteContext,
  ): Promise<
    | { kind: 'parsed'; parsed: RawRouteOutput }
    | { kind: 'parse_error'; message: string }
    | { kind: 'llm_error'; message: string }
    | null
  > {
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
    let res: Awaited<
      ReturnType<typeof this.openai.chat.completions.create>
    >;
    try {
      res = await this.openai.chat.completions.create({
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
      });
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

  /** Teach the collapse-pattern cache about NEW patterns the LLM
   *  emitted — fire-and-forget. Failure here doesn't affect routing. */
  private async teachCollapsePatterns(
    message: string,
    ctx: RouteContext,
    parsed: RawRouteOutput,
  ): Promise<void> {
    const knownLower = new Set(ctx.collapseSnapshot?.patterns.keys() ?? []);
    const newPairs: Array<{ pattern: string; replacement: string }> = [];
    for (const e of parsed.edits ?? []) {
      if (e.op !== 'collapse_state_change') continue;
      const span = validateSpan(message, nfc(message), e.sourceSpan);
      if (!span || !e.replacement) continue;
      const pattern = span.text;
      if (knownLower.has(pattern.toLowerCase())) continue;
      newPairs.push({ pattern, replacement: e.replacement });
    }
    if (newPairs.length === 0) return;
    try {
      await this.collapsePatterns.record(ctx.companyId, newPairs);
    } catch (e) {
      this.logger.warn(
        `collapse-pattern record failed for ${ctx.companyId}: ${(e as Error).message}`,
      );
    }
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

interface RouteContext {
  companyId: string;
  knownNames: string[];
  snapshot: PredicateSnapshot | null;
  predicateVocab: string[];
  nowIso: string;
  cacheKey: string;
  localTemporal: ReturnType<typeof extractTemporalLocally>;
  localMentions: ReturnType<typeof extractMentionsLocally>;
  localHints: Awaited<ReturnType<typeof extractPredicateHintsLocally>>;
  localCollapses: ReturnType<typeof extractCollapseEditsLocally>;
  collapseSnapshot:
    | { patterns: Map<string, { pattern: string; replacement: string }> }
    | null;
  localIntent: Awaited<ReturnType<IntentClassifierService['classify']>>;
}
