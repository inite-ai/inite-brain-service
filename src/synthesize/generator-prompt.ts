import {
  TEMPORAL_LANE_INSTRUCTION,
  TEMPORAL_INTERVAL_INSTRUCTION,
  ENUMERATION_LANE_INSTRUCTION,
  ORDERING_LANE_INSTRUCTION,
  CONTRADICTION_NOTE_INSTRUCTION,
  PREFERENCE_LANE_INSTRUCTION,
  SUMMARY_LANE_INSTRUCTION,
  STANDING_INSTRUCTIONS_INSTRUCTION,
  type AnswerLane,
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
  answerLang,
  dateContext,
  lane,
  ordering,
  intervalTable,
  instructions,
  conflicts,
}: {
  query: string;
  factLines: string[];
  /** Episodic-lane quotes (P2) — separate typed section after the facts. */
  transcriptLines?: string[];
  answerLang: string | null;
  dateContext?: string;
  /** T1 typed dispatch: lane-specific answer instruction. */
  lane?: AnswerLane | null;
  /** T2b: mention-order frame replaces the enumeration instruction. */
  ordering?: boolean;
  /** T1b: precomputed pairwise date-interval lines (event-anchored). */
  intervalTable?: string[];
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
  const laneInstruction =
    lane === 'enumeration'
      ? ordering
        ? ORDERING_LANE_INSTRUCTION
        : ENUMERATION_LANE_INSTRUCTION
      : lane === 'preference'
        ? PREFERENCE_LANE_INSTRUCTION
        : lane === 'summary'
          ? SUMMARY_LANE_INSTRUCTION
          : '';
  const intervalSection =
    intervalTable && intervalTable.length > 0
      ? `${TEMPORAL_INTERVAL_INSTRUCTION}Date-interval table (computed):\n${intervalTable.join('\n')}\n`
      : '';
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
  const transcriptSection =
    transcriptLines && transcriptLines.length > 0
      ? `\n\nTranscript excerpts (verbatim, chronological — use them to answer, but cite factIds only):\n${transcriptLines.join('\n')}`
      : '';
  return `Query: ${query}\n${dateInstruction}${laneInstruction}${intervalSection}${instructionSection}${conflictSection}\nRetrieved facts:\n${factLines.join('\n')}${transcriptSection}${langInstruction}`;
}
