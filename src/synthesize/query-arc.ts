/**
 * Query-time arc internals (V10 §4) — pure helpers for
 * insightEvidence='query_arc'.
 *
 * The v9arcs verdict: WRITE-time arcs are the wrong slot for
 * topic-specific summarization golds — coverage is thin by
 * construction (only fact-dense entities clear the composer's floor,
 * avg 4 arcs per world over 2 entities) and the stored topics are
 * decided blind to the questions. Query-time inverts it: extract the
 * TOPIC from the question, scan the fact record for it coverage-first
 * (the mention-scan doctrine, over knowledge_fact instead of
 * segments), and emit the most topical beats as one chronological
 * dated record — assembled per question, no stored rows, no composer
 * floor, any entity.
 *
 * Pure module — no DI, no IO, no env.
 */

/** Beats per prompt — the arc's own budget (the insight-slot doctrine:
 *  never compete with factBudget). */
const ARC_MAX_BEATS = 12;

/** Per-beat char cap (fact objects are single propositions; a runaway
 *  long object must not eat the section). */
const ARC_BEAT_CHAR_CAP = 200;

/**
 * Summary-question scaffolding, stripped to recover the topic phrase.
 * Order matters: multi-word scaffolds go before their substrings.
 */
const ARC_TOPIC_STRIP_RES: RegExp[] = [
  /\b(?:can|could|would|will) you\b/gi,
  /\bplease\b/gi,
  /\bgive me (?:a |an |the )?(?:comprehensive |detailed |brief )?(?:summary|overview|rundown|recap) of\b/gi,
  /\b(?:comprehensive |detailed |brief )?summar(?:y|ize|ise)\b/gi,
  /\bhow (?:has|have|did|is|was)\b/gi,
  /\b(?:progress(?:ed|ing)?|develop(?:ed|ing)?|evolv(?:e|ed|ing)|unfold(?:ed|ing)?|going|changed)\b/gi,
  /\btell me (?:everything )?about\b/gi,
  /\bwhat (?:happened|has happened|was going on) (?:with|to|around)\b/gi,
  /\bthe (?:story|history|journey|arc) of\b/gi,
  /\bover (?:time|the (?:last|past) \w+|the conversations?|our conversations?|the sessions?)\b/gi,
  /\bacross (?:the |our )?(?:sessions?|conversations?)\b/gi,
  /\b(?:did|do|have|has|had) (?:i|we|you)\b/gi,
  /\b(?:i|we|you) (?:worked on|brought up|mentioned|discussed|talked about)\b/gi,
  /\bso far\b/gi,
];

/**
 * Recover the topic phrase from a summary/narrative-shaped question by
 * stripping the ask scaffold. Falls back to the whole question when
 * the residue is too thin to search on. Deterministic — no LLM (the
 * mention-scan convention: the sub-second read path cannot afford an
 * extraction call, and the scaffold is lexically closed).
 */
export function extractArcTopic(query: string): string {
  let s = query ?? '';
  for (const re of ARC_TOPIC_STRIP_RES) s = s.replace(re, ' ');
  s = s
    .replace(/[?!.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an|my|our|your) /i, '')
    .trim();
  return s.length >= 3 ? s : (query ?? '').trim();
}

export interface ArcBeat {
  /** The proposition text (fact object). */
  object: string;
  /** ISO-ish validFrom string; first 10 chars are the day stamp. */
  validFrom: string;
  /** Cosine similarity vs the topic embedding (dense leg). */
  sim?: number | undefined;
  /** BM25 hit on the topic phrase (lexical leg). */
  lex?: number;
}

/**
 * Choose which beats make the record: most TOPICAL first (lexical
 * strength, then similarity — the mention-scan ranking), capped, then
 * re-sorted chronologically — a narrative needs its beats in event
 * order, but when the topic touches more facts than the budget, the
 * cut must keep the most relevant ones, not the earliest.
 */
export function pickArcBeats(beats: ArcBeat[], max: number = ARC_MAX_BEATS): ArcBeat[] {
  return [...beats]
    .sort((a, b) =>
      (a.lex ?? 0) !== (b.lex ?? 0) ? (b.lex ?? 0) - (a.lex ?? 0) : (b.sim ?? 0) - (a.sim ?? 0),
    )
    .slice(0, max)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
}

/** Render one dated beat line; drops beats with no usable text. */
export function renderArcLines(beats: ArcBeat[]): string[] {
  return beats
    .map((b) => {
      const text =
        b.object.length > ARC_BEAT_CHAR_CAP
          ? `${b.object.slice(0, ARC_BEAT_CHAR_CAP - 1)}…`
          : b.object;
      const day = b.validFrom.slice(0, 10);
      return text.trim().length > 0 ? `- [${day}] ${text.trim()}` : '';
    })
    .filter((l) => l.length > 0);
}
