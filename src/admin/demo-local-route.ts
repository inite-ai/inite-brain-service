import type { ChatRoute } from './chat-router-internals/types';
import {
  extractMentionsLocally,
  extractTemporalLocally,
} from './chat-router-internals/local-prepass';

/**
 * The read-only demo's route: the chat router's local pre-pass alone.
 *
 * The router's full path may call a model (the intent/slot LLM, the
 * embedding predicate hints); the public demo makes no model call, so it
 * keeps only the deterministic parts — lexical mention resolve against
 * the tenant's known names and the chrono temporal anchor — and the
 * intent is always `ask`: a demo visitor's line is a question about the
 * memory, never something to remember. Nothing on this route reaches the
 * tell (ingest) flow.
 */
export function localAskRoute(message: string, knownNames: string[], now: Date): ChatRoute {
  const mentions = extractMentionsLocally(message, knownNames).map((m) => ({
    canonical: m.canonical,
    span: m.span,
  }));
  const temporal = extractTemporalLocally(message, now);
  return {
    intent: 'ask',
    normalizedMessage: message,
    mentions,
    predicateHints: [],
    ...(temporal ? { asOf: { iso: temporal.iso, anchorSpan: temporal.span } } : {}),
    reason: 'demo-readonly-local',
  };
}
