import {
  TEMPORAL_LANE_INSTRUCTION,
  CONTRADICTION_NOTE_INSTRUCTION,
  CONTRADICTION_DATE_ARBITRATION_INSTRUCTION,
  ORDERING_LANE_INSTRUCTION,
  STANDING_INSTRUCTIONS_INSTRUCTION,
  STRATEGY_ADVISORY_INSTRUCTION,
  ENUM_STRICT_CLAUSE,
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
  orderingFrame,
  dateArbitratedConflicts,
  arcInsights,
  answerLang,
  dateContext,
  lane,
  instructions,
  conflicts,
  enumStrict,
  dateMathLines,
  shapeInstruction,
  strategyNotes,
}: {
  query: string;
  factLines: string[];
  /** Episodic-lane quotes (P2) — separate typed section after the facts. */
  transcriptLines?: string[] | undefined;
  /**
   * Derived insights (V8 §1) — aggregates and summaries in their own
   * separately-budgeted section, so they never displace fact lines.
   */
  insightLines?: string[] | undefined;
  /**
   * V8 §2: the transcript excerpts were collected as TIMELINE evidence
   * for an ordering-shaped question — flag them as the mention record
   * so the generator derives order-of-mention from the excerpt
   * sequence, not from fact date stamps (event-time extraction
   * collapses a session's mentions onto one date).
   */
  timelineEvidence?: boolean | undefined;
  /**
   * V10 §3: the ordering frame replaces the (enumeration) lane frame —
   * short aspect labels in the mention record's order, honor the
   * requested N. Set only when the mention record fired AND the
   * profile opted in (orderingFrame && timelineEvidence).
   */
  orderingFrame?: boolean | undefined;
  /**
   * V10 §2b: date-arbitrating conflict frame — different-day conflict
   * pairs commit to the latest value and note the earlier as
   * previous; same-day pairs keep the hedge. Set from
   * profile.updateStoryRendering; off = the blanket hedge frame,
   * byte-identical.
   */
  dateArbitratedConflicts?: boolean | undefined;
  /**
   * V10 §4: the insight lines are a query-time TOPIC RECORD (dated
   * atomic beats assembled for the asked topic) rather than stored
   * summaries — the header must say what the section is.
   */
  arcInsights?: boolean | undefined;
  answerLang: string | null;
  dateContext?: string | undefined;
  /** T1 typed dispatch: lane-specific answer instruction. */
  lane?: LaneId | null | undefined;
  /** T7: standing user instructions rendered as their own section. */
  instructions?: string[] | undefined;
  /** T3: write-side COMPETING conflict pairs present in the evidence. */
  conflicts?: Array<{ factIds: string[]; label: string }> | undefined;
  /**
   * §8 item 3 (profile.enumStrict): scope discipline appended to the
   * enumeration lane frame — the measured judge-sink class is answers
   * listing the gold items PLUS thematically adjacent extras.
   */
  enumStrict?: boolean | undefined;
  /**
   * V13 (profile.dateMath): computed date table — weekday + exact
   * event-to-event gaps for every dated evidence day, so the model
   * never does raw calendar arithmetic. Empty/undefined = no section.
   */
  dateMathLines?: string[] | undefined;
  /**
   * V13 G2 (profile.answerConditioning): the per-shape reading
   * instruction from answer-shape.ts; composes with the lane frame.
   */
  shapeInstruction?: string | undefined;
  /**
   * G4 strategy lane: advisory notes rendered as a clearly fenced
   * section at the END of the message — guidance, not evidence.
   * GENERATOR-ONLY by design: the verifier never sees these (the
   * documented parity exception; see CollectedEvidence.strategyNotes
   * and verifier.ts). Empty/undefined = no section, byte-identical.
   */
  strategyNotes?: string[] | undefined;
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
  // V10 §3: the ordering frame takes the slot over the lane frame
  // when the mention record fired for this query.
  const laneInstruction = orderingFrame
    ? ORDERING_LANE_INSTRUCTION
    : lane && lane !== 'temporal'
      ? (laneInstructionFor(lane) ?? '') +
        (lane === 'enumeration' && enumStrict ? ENUM_STRICT_CLAUSE : '')
      : '';
  const instructionSection =
    instructions && instructions.length > 0
      ? `${STANDING_INSTRUCTIONS_INSTRUCTION}Standing instructions:\n${instructions
          .map((i) => `- ${i}`)
          .join('\n')}\n`
      : '';
  const conflictNote = dateArbitratedConflicts
    ? CONTRADICTION_DATE_ARBITRATION_INSTRUCTION
    : CONTRADICTION_NOTE_INSTRUCTION;
  const conflictSection =
    conflicts && conflicts.length > 0
      ? `Conflict pairs (write-side COMPETING):\n${conflicts
          .map((c) => `- ${c.label}: ${c.factIds.join(' vs ')}`)
          .join('\n')}\n${conflictNote}`
      : '';
  const transcriptHeader = timelineEvidence
    ? 'Transcript excerpts (verbatim, chronological — this is the MENTION RECORD: derive the order in which topics were raised from the sequence of excerpts and their dates, preferring it over fact date stamps; cite factIds only):'
    : 'Transcript excerpts (verbatim, chronological — use them to answer, but cite factIds only):';
  const transcriptSection =
    transcriptLines && transcriptLines.length > 0
      ? `\n\n${transcriptHeader}\n${transcriptLines.join('\n')}`
      : '';
  const insightHeader = arcInsights
    ? 'Topic record (dated beats retrieved for the asked topic, chronological — use them to structure the narrative/overview, prefer the atomic facts for specifics, cite factIds only):'
    : 'Derived insights (summaries composed from the facts — use them for overview/enumeration structure, prefer the atomic facts for specifics, cite factIds only):';
  const insightSection =
    insightLines && insightLines.length > 0
      ? `\n\n${insightHeader}\n${insightLines.join('\n')}`
      : '';
  const dateMathSection =
    dateMathLines && dateMathLines.length > 0
      ? `\n\nDate table (computed from the fact date stamps — trust it over your own arithmetic; gaps are between EVIDENCE dates, not from today):\n${dateMathLines.join('\n')}`
      : '';
  return `Query: ${query}\n${dateInstruction}${shapeInstruction ?? ''}${laneInstruction}${instructionSection}${conflictSection}\nRetrieved facts:\n${factLines.join('\n')}${transcriptSection}${insightSection}${dateMathSection}${renderStrategySection(strategyNotes)}${langInstruction}`;
}

/**
 * G4 advisory section — hard-fenced so the model cannot mistake advice
 * for evidence; rendered after every evidence section. Empty input =
 * empty string (byte-identical prompt without the lane).
 */
function renderStrategySection(strategyNotes?: string[]): string {
  if (!strategyNotes || strategyNotes.length === 0) return '';
  const notes = strategyNotes.map((n) => `- ${n}`).join('\n');
  return (
    `\n\n=== ADVISORY STRATEGY NOTES (guidance, not evidence — never cite) ===\n` +
    `${STRATEGY_ADVISORY_INSTRUCTION}${notes}\n=== END ADVISORY STRATEGY NOTES ===`
  );
}
