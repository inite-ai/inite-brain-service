import * as chrono from 'chrono-node';
import type { EmbedderService } from '../../ai/embedder.service';
import type { PredicateSnapshot } from '../../ai/predicate-registry.service';
import { cosineSimilarity } from '../../common/vector-math';
import { traceArtifact } from '../../common/debug-trace';
import type { Span } from './types';

/**
 * Temporal anchor extraction via chrono-node. Handles EN + RU + common
 * code-switched cases at 1-5ms (vs gpt-4o-mini's 1-3s). Returns the
 * first parsed result with its character span — the same shape the LLM
 * would have produced.
 *
 * chrono-node coverage: yesterday / next month / in March / last week /
 * 3 days ago / вчера / в марте / на прошлой неделе / через неделю /
 * следующий месяц. Failure modes (implicit anchors like "when I get
 * back") fall through to the LLM via the orchestrator merge.
 */
export function extractTemporalLocally(
  message: string,
  ref: Date,
): { iso: string; span: { text: string; start: number; end: number } } | null {
  try {
    const results = chrono.parse(message, ref, { forwardDate: false });
    if (!results || results.length === 0) return null;
    const first = results[0];
    const date = first.start?.date?.();
    if (!date || Number.isNaN(date.getTime())) return null;
    const text = first.text;
    const start = first.index;
    const end = start + text.length;
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      start < 0 ||
      end > message.length ||
      message.slice(start, end) !== text
    ) {
      return null;
    }
    return { iso: date.toISOString(), span: { text, start, end } };
  } catch {
    return null;
  }
}

/**
 * Lexical mention resolution against the per-tenant knownNames list.
 * Matches canonical names AND first-name aliases by case-insensitive
 * substring — covers the "Maria" → "Maria Petrov" canonicalisation
 * without an LLM call. Sub-millisecond at demo scale (≤200 names).
 *
 * Returns each match with its grounded span (offset into the original
 * message) so the validateAndAssemble pipeline accepts it directly.
 *
 * Future: Aho-Corasick for tenants with N>200 names (one trie scan vs
 * N substring searches).
 */
type MentionMatch = {
  canonical: string;
  span: { text: string; start: number; end: number };
};

export function extractMentionsLocally(
  message: string,
  knownNames: string[],
): MentionMatch[] {
  if (knownNames.length === 0) return [];
  const lowerMessage = message.toLowerCase();
  const accepted: MentionMatch[] = [];
  const occupied: Array<[number, number]> = [];
  // Match longest canonical names first ("Maria Petrov" before "Maria")
  // so the full form wins when both substrings are present.
  const namesByLength = [...knownNames].sort((a, b) => b.length - a.length);
  for (const canonical of namesByLength) {
    matchCanonicalForm({
      canonical,
      message,
      lowerMessage,
      occupied,
      accepted,
    });
    matchFirstTokenForm({
      canonical,
      knownNames,
      message,
      lowerMessage,
      occupied,
      accepted,
    });
  }
  return accepted;
}

/** Scan the message for the full canonical form. Honours `occupied`
 *  so longer matches recorded earlier in the pass win. */
function matchCanonicalForm({
  canonical,
  message,
  lowerMessage,
  occupied,
  accepted,
}: {
  canonical: string;
  message: string;
  lowerMessage: string;
  occupied: Array<[number, number]>;
  accepted: MentionMatch[];
}): void {
  const needle = canonical.toLowerCase();
  if (needle.length < 2) return;
  let from = 0;
  while (from < lowerMessage.length) {
    const idx = lowerMessage.indexOf(needle, from);
    if (idx < 0) return;
    const end = idx + needle.length;
    pushIfFree({ canonical, message, start: idx, end, occupied, accepted });
    from = end;
  }
}

/**
 * Also match the FIRST token of the canonical name (e.g. "Maria" for
 * "Maria Petrov"). Skipped when the first token clashes with another
 * knownName's first token (ambiguous case — leave it to the LLM).
 */
function matchFirstTokenForm({
  canonical,
  knownNames,
  message,
  lowerMessage,
  occupied,
  accepted,
}: {
  canonical: string;
  knownNames: string[];
  message: string;
  lowerMessage: string;
  occupied: Array<[number, number]>;
  accepted: MentionMatch[];
}): void {
  const tokens = canonical.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return;
  const firstToken = tokens[0];
  if (firstTokenCollides(firstToken, canonical, knownNames)) return;
  const needle = firstToken.toLowerCase();
  if (needle.length < 2) return;
  let from = 0;
  while (from < lowerMessage.length) {
    const idx = lowerMessage.indexOf(needle, from);
    if (idx < 0) return;
    const end = idx + needle.length;
    if (isWordBoundary(message, idx, end)) {
      pushIfFree({ canonical, message, start: idx, end, occupied, accepted });
    }
    from = end;
  }
}

function firstTokenCollides(
  firstToken: string,
  canonical: string,
  knownNames: string[],
): boolean {
  const prefix = firstToken.toLowerCase() + ' ';
  return knownNames.some(
    (other) =>
      other !== canonical && other.toLowerCase().startsWith(prefix),
  );
}

/** Word-boundary check so "Mariana" isn't matched as "Maria". */
function isWordBoundary(message: string, idx: number, end: number): boolean {
  const before = idx > 0 ? message[idx - 1] : ' ';
  const after = end < message.length ? message[end] : ' ';
  return !isWordChar(before) && !isWordChar(after);
}

function isWordChar(c: string): boolean {
  return /[\p{L}\p{N}]/u.test(c);
}

function pushIfFree({
  canonical,
  message,
  start,
  end,
  occupied,
  accepted,
}: {
  canonical: string;
  message: string;
  start: number;
  end: number;
  occupied: Array<[number, number]>;
  accepted: MentionMatch[];
}): void {
  if (occupied.some(([s, e]) => !(end <= s || start >= e))) return;
  accepted.push({
    canonical,
    span: { text: message.slice(start, end), start, end },
  });
  occupied.push([start, end]);
}

/**
 * Embedding-based predicate-hint extraction. Compares the user-message
 * embedding against the per-predicate embeddings already stored by the
 * registry (each predicate is embedded at bootstrap as part of the EDC
 * pipeline — see migration 0012). Emits a hint for every predicate
 * whose cosine similarity ≥ threshold, capped at maxHints, ranked by
 * similarity descending.
 *
 * triggerSpan covers the whole message — the embedding aggregates over
 * all tokens, so there is no localized phrase to anchor.
 *
 * Cost: ~50ms per cache miss (one OpenAI embedding round-trip; the
 * embedder's LRU cache absorbs repeated identical queries). Skipped
 * entirely on cache hit.
 *
 * Failure modes degrade silently to empty hints — the LLM still
 * produces its own hints and validation handles missing slots.
 */
export interface ExtractPredicateHintsLocallyOptions {
  message: string;
  snapshot: PredicateSnapshot | null;
  embedder: EmbedderService;
  threshold: number;
  maxHints: number;
}

export async function extractPredicateHintsLocally({
  message,
  snapshot,
  embedder,
  threshold,
  maxHints,
}: ExtractPredicateHintsLocallyOptions): Promise<
  Array<{ predicateId: string; similarity: number; triggerSpan: Span }>
> {
  if (!snapshot || snapshot.embeddings.size === 0) return [];
  if (message.length === 0) return [];
  let queryVec: number[];
  try {
    queryVec = await embedder.embed(message);
  } catch (e) {
    // Embedder outage degrades chat-router to a no-hint pass. Emit a
    // trace event so a debug-trace consumer can see the silent skip;
    // operators correlating router-quality dips to upstream LLM
    // health then have a clear signal.
    traceArtifact('chat_router.local_prepass.embed_error', {
      message: (e as Error).message ?? String(e),
    });
    return [];
  }
  const scored: Array<{ predicateId: string; similarity: number }> = [];
  for (const [predicateId, predEmb] of snapshot.embeddings) {
    const sim = cosineSimilarity(queryVec, predEmb);
    if (sim >= threshold) {
      scored.push({ predicateId, similarity: sim });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  const span: Span = { text: message, start: 0, end: message.length };
  return scored.slice(0, maxHints).map(({ predicateId, similarity }) => ({
    predicateId,
    similarity,
    triggerSpan: span,
  }));
}

/**
 * Local intent classifier — punctuation-only.
 *
 * The only signal is the universal interrogative mark `?`. No
 * enumerated lexicon of wh-pronouns, no list of imperative-search
 * phrases — those are surface-form catalogues that rot per language
 * and read as magic in code.
 *
 * Confidence levels feed the LLM-skip gate:
 *   trailing `?`  → ask, 0.95
 *   otherwise     → tell, 0.70
 *   empty         → tell, 0
 */
export function classifyIntentLocally(message: string): {
  intent: 'ask' | 'tell';
  confidence: number;
} {
  if (message.trim().length === 0) {
    return { intent: 'tell', confidence: 0 };
  }
  if (/\?\s*$/.test(message)) {
    return { intent: 'ask', confidence: 0.95 };
  }
  return { intent: 'tell', confidence: 0.7 };
}

/**
 * Confidence-gated decision: can we serve this route entirely from
 * local pre-pass and skip the LLM call?
 *
 * Conservative gates: each check must pass or we fall through to the
 * LLM (the LLM is the safety net for everything heuristics can't cover).
 *   - intent confidence ≥ intentConfidenceFloor
 *   - at least one mention resolved (route needs a subject)
 *   - ASK: at least one predicate hint emitted
 *   - TELL: at least one cached collapse edit fired
 */
export function shouldSkipLLM(input: {
  intent: 'ask' | 'tell';
  intentConfidence: number;
  localMentions: Array<{ canonical: string; span: Span }>;
  localHints: Array<{
    predicateId: string;
    similarity: number;
    triggerSpan: Span;
  }>;
  localCollapses: Array<{
    pattern: string;
    replacement: string;
    span: { text: string; start: number; end: number };
  }>;
  intentConfidenceFloor: number;
}): { skip: boolean; reason: string } {
  if (input.intentConfidence < input.intentConfidenceFloor) {
    return { skip: false, reason: 'intent_confidence_low' };
  }
  if (input.localMentions.length === 0) {
    return { skip: false, reason: 'no_mentions_resolved' };
  }
  if (input.intent === 'ask') {
    if (input.localHints.length === 0) {
      return { skip: false, reason: 'no_predicate_hints' };
    }
    return { skip: true, reason: 'all_local_ask' };
  }
  if (input.localCollapses.length === 0) {
    return { skip: false, reason: 'tell_no_cached_collapses' };
  }
  return { skip: true, reason: 'all_local_tell' };
}
