import { Injectable, Logger } from '@nestjs/common';
import { traceArtifact } from '../common/debug-trace';
import { PredicatePlanService } from './predicate-plan.service';
import { IntentClassifierService } from './intent-classifier.service';
import {
  CollapsePatternService,
  extractCollapseEditsLocally,
} from './collapse-pattern.service';
import {
  extractMentionsLocally,
  extractTemporalLocally,
} from './chat-router-internals/local-prepass';
import { nfc, validateSpan } from './chat-router-internals/validator';
import type { RawRouteOutput } from './chat-router-internals/types';
import type { RouteContext, RoutePlan } from './chat-route-context';

/**
 * Local pre-pass / planning stage of the chat router: chrono temporal extract,
 * lexical mention resolve, embedding-based predicate hints (via
 * {@link PredicatePlanService}), collapse-pattern cache lookup, and NLI intent
 * classification. Also teaches the collapse-pattern cache new patterns the LLM
 * emitted. Three injected deps (predicate-plan / intent / collapse).
 */
@Injectable()
export class ChatRoutePlannerService {
  private readonly logger = new Logger(ChatRoutePlannerService.name);

  constructor(
    private readonly predicatePlan: PredicatePlanService,
    private readonly intentClassifier: IntentClassifierService,
    private readonly collapsePatterns: CollapsePatternService,
  ) {}

  async buildContext(
    message: string,
    options: { knownNames?: string[]; now?: Date; companyId: string },
  ): Promise<RoutePlan> {
    const knownNames = options.knownNames ?? [];
    const nowIso = (options.now ?? new Date()).toISOString();
    const refDate = options.now ?? new Date();

    const { snapshot, predicateVocab, localHints } =
      await this.predicatePlan.plan(message, options.companyId);

    const localTemporal = extractTemporalLocally(message, refDate);
    const localMentions = extractMentionsLocally(message, knownNames);
    traceArtifact('demo.chat.local_planner', {
      temporal: localTemporal,
      mentions: localMentions,
      knownNamesCount: knownNames.length,
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
      localTemporal,
      localMentions,
      localHints,
      localCollapses,
      collapseSnapshot,
      localIntent,
    };
  }

  /** Teach the collapse-pattern cache about NEW patterns the LLM emitted —
   *  fire-and-forget. Failure here doesn't affect routing. */
  async teachCollapsePatterns(
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
}
