import type { PredicateSnapshot } from '../ai/predicate-registry.service';
import type {
  extractTemporalLocally,
  extractMentionsLocally,
  extractPredicateHintsLocally,
} from './chat-router-internals/local-prepass';
import type { extractCollapseEditsLocally } from './collapse-pattern.service';
import type { IntentClassifierService } from './intent-classifier.service';

/**
 * Per-request local pre-pass bundle threaded through the chat-router stages
 * (planner → llm → orchestrator). `cacheKey` is filled by the orchestrator
 * after the planner returns (it owns the route cache); everything else is the
 * planner's output.
 */
export interface RouteContext {
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

/** The planner's output — a RouteContext minus the cache key. */
export type RoutePlan = Omit<RouteContext, 'cacheKey'>;
