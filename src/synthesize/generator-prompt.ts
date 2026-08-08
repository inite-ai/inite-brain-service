import {
  TEMPORAL_LANE_INSTRUCTION,
  CONTRADICTION_NOTE_INSTRUCTION,
  STANDING_INSTRUCTIONS_INSTRUCTION,
  laneInstructionFor,
  type LaneId,
} from './answer-router';

/**
 * Generator user-message assembly, exported for byte-equality tests.
 * Split out of synthesize.service (max-lines budget) — pure string
 * work, no IO. Without `dateContext` the output is identical to the
 * historical format; with it, an anchored "Today" + date-arithmetic
 * instruction sits between the query and the fact list
 * (SYNTHESIZE_DATE_CONTEXT).
 */
export function buildGeneratorUserMessage({
  query,
  factLines,
  transcriptLines,
  insightLines,
  timelineEvidence,
  answerLang,
  dateContext,
  lane,
  instructions,
  conflicts,
}: {
  query: string;
  factLines: string[];
  /** Episodic-lane quotes (P2) — separate typed section after the facts. */
  transcriptLines?: string[];
  /**
   * Derived insights (V8 §1) — aggregates and summaries in their own
   * separately-budgeted section, so they never displace fact lines.
   */
  insightLines?: string[];
  /**
   * V8 §2: the transcript excerpts were collected as TIMELINE evidence
   * for an ordering-shaped question — flag them as the mention record
   * so the generator derives order-of-mention from the excerpt
   * sequence, not from fact date stamps (event-time extraction
   * collapses a session's mentions onto one date).
   */
  timelineEvidence?: boolean;
  answerLang: string | null;
  dateContext?: string;
  /** T1 typed dispatch: lane-specific answer instruction. */
  lane?: LaneId | null;
  /** T7: standing user instructions rendered as their own section. */
  instructions?: string[];
  /** T3: write-side COMPETING conflict pairs present in the evidence. */
  conflicts?: Array<{ factIds: string[]; label: string }>;
}): string {
  const langInstruction = answerLang
    ? `\n\nLanguage policy: write your answer in ${answerLang} (ISO 639-1). Keep citation spans in their original language.`
    : '';
  const dateInstruction = dateContext
    ? `Today: ${dateContext}. Facts carry date stamps like (as of YYYY-MM-DD). Resolve relative time expressions ("last week", "next month") against the stamp of the fact that states them, and answer "when" questions with a specific date or period, using simple date arithmetic when needed.\n` +
      (lane === 'temporal' ? TEMPORAL_LANE_INSTRUCTION : '')
    : '';
  // Lane frame from the registry — the temporal frame renders inside
  // the date block above instead (it needs the anchored "Today").
  const laneInstruction =
    lane && lane !== 'temporal' ? (laneInstructionFor(lane) ?? '') : '';
  const instructionSection =
    instructions && instructions.length > 0
      ? `${STANDING_INSTRUCTIONS_INSTRUCTION}Standing instructions:\n${instructions
          .map((i) => `- ${i}`)
          .join('\n')}\n`
      : '';
  const conflictSection =
    conflicts && conflicts.length > 0
      ? `Conflict pairs (write-side COMPETING):\n${conflicts
          .map((c) => `- ${c.label}: ${c.factIds.join(' vs ')}`)
          .join('\n')}\n${CONTRADICTION_NOTE_INSTRUCTION}`
      : '';
  const transcriptHeader = timelineEvidence
    ? 'Transcript excerpts (verbatim, chronological — this is the MENTION RECORD: derive the order in which topics were raised from the sequence of excerpts and their dates, preferring it over fact date stamps; cite factIds only):'
    : 'Transcript excerpts (verbatim, chronological — use them to answer, but cite factIds only):';
  const transcriptSection =
    transcriptLines && transcriptLines.length > 0
      ? `\n\n${transcriptHeader}\n${transcriptLines.join('\n')}`
      : '';
  const insightSection =
    insightLines && insightLines.length > 0
      ? `\n\nDerived insights (summaries composed from the facts — use them for overview/enumeration structure, prefer the atomic facts for specifics, cite factIds only):\n${insightLines.join('\n')}`
      : '';
  return `Query: ${query}\n${dateInstruction}${laneInstruction}${instructionSection}${conflictSection}\nRetrieved facts:\n${factLines.join('\n')}${transcriptSection}${insightSection}${langInstruction}`;
}
