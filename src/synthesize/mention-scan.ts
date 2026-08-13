/**
 * Mention-scan internals (V9 §2) — pure helpers for the topic-scan
 * mention record under timelineEvidence='scan'.
 *
 * The measured event_ordering failure is COVERAGE, not order: golds
 * want a curated K-item sequence of topic mentions across ALL sessions,
 * and top-K similarity windows structurally cannot enumerate it (V8
 * timeline leg: 0→2.5 with the top-K appendix). The scan inverts the
 * shape: extract the TOPIC from the question, test every session of
 * the record for a mention of it, and emit ONE dated line per
 * session-mention in occurredAt order — bounded by session count, not
 * top-K.
 *
 * Pure module — no DI, no IO, no env.
 */

import { SESSION_GAP_MS } from '../episodes/session-window';

/** Hard cap on emitted mention lines (a runaway topic that matches
 *  every session must not replace the whole transcript). */
export const MAX_MENTION_LINES = 60;

/** Per-line char cap for the mention record. */
const MENTION_LINE_CHAR_CAP = 240;

/** Dense-only mentions must clear BOTH: an absolute cosine floor and a
 *  fraction of the best similarity seen (adapts to embedding scale). */
const SCAN_ABS_SIM_FLOOR = 0.35;
const SCAN_RELATIVE_SIM = 0.9;

/**
 * Ordering-question scaffolding, stripped to recover the topic phrase.
 * Order matters: multi-word scaffolds go before their substrings.
 */
const TOPIC_STRIP_RES: RegExp[] = [
  /\b(?:can|could|would|will) you\b/gi,
  /\bplease\b/gi,
  /\bwalk me through\b/gi,
  // V10 §3 (R1): the exact-N answer constraint is question SCAFFOLD,
  // not topic — "Mention ONLY and ONLY three items in your answer"
  // leaked mention/only/items into the topic terms and polluted both
  // scan legs (measured on the v10ordering EO failures).
  /\bmention only and only\b/gi,
  /\b(?:exactly |just )?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+) items?\b/gi,
  /\bin your answer\b/gi,
  /\b(?:list|name|tell me|describe) (?:the )?order(?: in which| of)?\b/gi,
  /\bin (?:what|which) order\b/gi,
  /\bwhat (?:is|was) the order of\b/gi,
  /\blist in order\b/gi,
  /\bthe order in which\b/gi,
  /\bwhich (?:came|happened|occurred) (?:first|last|earlier|later)\b/gi,
  /\bbefore or after\b/gi,
  /\b(?:did|do|have|has|had) (?:i|we|you)\b/gi,
  /\b(?:i|we|you) (?:brought up|raised|mentioned|discussed|talked about|covered|asked about)\b/gi,
  /\b(?:different|various|the) aspects? of\b/gi,
  /\b(?:topics?|things|items) (?:about|around|related to|regarding)\b/gi,
  /\bover (?:time|the conversations?|our conversations?|the sessions?)\b/gi,
  /\bacross (?:the |our )?(?:sessions?|conversations?)\b/gi,
];

/**
 * Recover the topic phrase from an ordering-shaped question by
 * stripping the ordering scaffold. Falls back to the whole question
 * when the residue is too thin to search on. Deterministic — no LLM.
 */
export function extractOrderingTopic(query: string): string {
  let s = query ?? '';
  for (const re of TOPIC_STRIP_RES) s = s.replace(re, ' ');
  s = s
    .replace(/[?!.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading articles/possessives survive the scaffold strip.
    .replace(/^(?:the|a|an|my|our|your) /i, '')
    .trim();
  return s.length >= 3 ? s : (query ?? '').trim();
}

/** Topic terms for line picking: lowercase tokens ≥3 chars, minus glue. */
const TERM_STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'about',
  'into',
  'from',
  'over',
  'have',
  'has',
  'had',
  'was',
  'were',
  'are',
  'you',
  'your',
  'our',
  // V10 §3 (R1): ask-scaffold words that survive the strip in odd
  // phrasings must never count as topic terms.
  'mention',
  'only',
  'item',
  'items',
  'order',
  'answer',
]);

export function topicTerms(topic: string): string[] {
  return [
    ...new Set(
      (topic ?? '')
        .toLowerCase()
        .split(/[^a-z0-9а-яё]+/i)
        .filter((t) => t.length >= 3 && !TERM_STOP.has(t)),
    ),
  ];
}

export interface ScanRow {
  id: string;
  text: string;
  occurredAt: number;
  /** Cosine similarity vs the topic embedding (dense leg). */
  sim?: number;
  /** BM25 hit on the topic phrase (lexical leg). */
  lex?: number;
}

/**
 * Decide which scanned rows count as MENTIONS. Lexical hits always do
 * (the topic's words literally appear); dense-only rows must clear both
 * the absolute floor and a fraction of the best similarity — otherwise
 * a vague topic would flag every session and the mention record would
 * degenerate into the whole transcript.
 */
export function filterMentions(rows: ScanRow[]): ScanRow[] {
  const topSim = rows.reduce((m, r) => Math.max(m, r.sim ?? 0), 0);
  const denseFloor = Math.max(SCAN_ABS_SIM_FLOOR, topSim * SCAN_RELATIVE_SIM);
  return rows.filter(
    (r) => (r.lex ?? 0) > 0 || (r.sim !== undefined && r.sim >= denseFloor),
  );
}

/**
 * Group mention rows into sessions by inactivity gap (the deriver's
 * 60-minute convention) and keep ONE best row per session — lexical
 * strength first, similarity second. Output is chronological by
 * construction.
 */
export function bestMentionPerSession(
  rows: ScanRow[],
  gapMs: number = SESSION_GAP_MS,
): ScanRow[] {
  const sorted = [...rows].sort((a, b) => a.occurredAt - b.occurredAt);
  const out: ScanRow[] = [];
  let best: ScanRow | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  const better = (a: ScanRow, b: ScanRow): boolean =>
    (a.lex ?? 0) !== (b.lex ?? 0)
      ? (a.lex ?? 0) > (b.lex ?? 0)
      : (a.sim ?? 0) > (b.sim ?? 0);
  for (const r of sorted) {
    if (best && r.occurredAt - lastAt > gapMs) {
      out.push(best);
      best = null;
    }
    if (!best || better(r, best)) best = r;
    lastAt = r.occurredAt;
  }
  if (best) out.push(best);
  return out;
}

/**
 * V10 §3 aspect dedup. Two sessions repeating the same aspect both
 * emit a mention line (the per-session collapse can't see across
 * sessions, and the exact-string dedup downstream can't either — the
 * date prefix and wording differ). Repeats inflate the record and
 * fight the ordering golds' exact-N constraint, so near-duplicate
 * lines collapse into the EARLIEST one — the first mention is the
 * ordering-relevant beat. Containment test on informative tokens:
 * the smaller line must share ≥70% of its tokens with a kept line
 * and carry at least 3 of them (thinner lines are too weak to judge).
 */
const DEDUP_MIN_TOKENS = 3;
const DEDUP_CONTAINMENT = 0.7;

function mentionTokens(line: string): Set<string> {
  const text = line
    .replace(/^\[[^\]]*\]\s*/, '') // date prefix
    .replace(/^[^:]{0,40}:\s*/, ''); // speaker label
  return new Set(topicTerms(text));
}

export function dedupeMentionLines(lines: string[]): string[] {
  const kept: Array<Set<string>> = [];
  const out: string[] = [];
  for (const line of lines) {
    const tokens = mentionTokens(line);
    const dup = kept.some((k) => {
      const [small, big] = tokens.size <= k.size ? [tokens, k] : [k, tokens];
      if (small.size < DEDUP_MIN_TOKENS) return false;
      let shared = 0;
      for (const t of small) if (big.has(t)) shared += 1;
      return shared / small.size >= DEDUP_CONTAINMENT;
    });
    if (!dup) {
      kept.push(tokens);
      out.push(line);
    }
  }
  return out;
}

/**
 * Pick the single most topic-relevant line from a segment's rendered
 * text (lines are "[YYYY-MM-DD] speaker: text"). Term-overlap scoring,
 * first line on ties/zero — the segment matched as a whole, so its
 * opening line is still a dated mention anchor.
 */
export function pickMentionLine(segmentText: string, terms: string[]): string {
  const lines = (segmentText ?? '').split('\n').filter((l) => l.trim());
  if (lines.length === 0) return '';
  let bestLine = lines[0];
  let bestScore = 0;
  for (const line of lines) {
    const lower = line.toLowerCase();
    let score = 0;
    for (const t of terms) if (lower.includes(t)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLine = line;
    }
  }
  return bestLine.length > MENTION_LINE_CHAR_CAP
    ? `${bestLine.slice(0, MENTION_LINE_CHAR_CAP - 1)}…`
    : bestLine;
}
