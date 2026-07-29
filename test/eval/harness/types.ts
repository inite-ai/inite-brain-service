/**
 * The shared shape of a "world axis" benchmark (LongMemEval, BEAM):
 * isolated haystack worlds — one tenant each — probed by dated
 * questions. LoCoMo deliberately does NOT use this harness: it is the
 * validated quality-axis instrument (single shared tenant, per-category
 * judge, fixture-pinned wire shapes) and stays frozen mid-program.
 */

export interface EvalTurn {
  role: string;
  content: string;
}

export interface EvalSession {
  sessionId: string;
  dateIso: string;
  turns: EvalTurn[];
}

export interface EvalQuestion {
  id: string;
  /** Reporting bucket: LongMemEval question type / BEAM ability. */
  group: string;
  question: string;
  gold: string;
  /** Richer gold shown to the judge (e.g. BEAM rubric); defaults to gold. */
  judgeGold?: string;
  /** Correct behavior is declining to answer. */
  isAbstention: boolean;
  /** as-of date for retrieval (question-dated correctness). */
  askedAtIso: string;
  /** Copied verbatim onto the score row (difficulty etc.). */
  meta?: Record<string, unknown>;
}

export interface EvalWorld {
  tenant: string;
  /** Vertical-prefixed conversation id, e.g. `lme:<qid>` / `beam:100k-1`. */
  conversationRef: string;
  vertical: string;
  sessions: EvalSession[];
  questions: EvalQuestion[];
}

export interface EvalScore {
  questionId: string;
  group: string;
  question: string;
  gold: string;
  prediction: string;
  isAbstention: boolean;
  abstained: boolean;
  promptTokens?: number;
  errored?: string;
  judgeCorrect?: boolean;
  [meta: string]: unknown;
}
