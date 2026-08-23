import { promises as fs } from 'node:fs';

/**
 * LongMemEval loader (Wu et al., ICLR 2025 — arXiv 2410.10813).
 *
 * The S split is 500 questions; EACH question carries its own haystack of
 * ~40-60 chat sessions (~115k tokens) mixing evidence and distractors, so
 * evaluation isolates one tenant per question. Question ids ending in
 * `_abs` are the abstention subset — the correct behavior is to decline.
 */

export interface LmeTurn {
  role: 'user' | 'assistant' | string;
  content: string;
}

export interface LmeSession {
  sessionId: string;
  /** Upstream format: "2023/05/20 (Sat) 02:21" — parsed to ISO. */
  dateIso: string;
  turns: LmeTurn[];
}

export interface LmeQuestion {
  questionId: string;
  questionType: string;
  question: string;
  answer: string;
  questionDateIso: string;
  sessions: LmeSession[];
  /** Abstention subset: correct = decline to answer. */
  isAbstention: boolean;
}

/** "2023/05/20 (Sat) 02:21" → ISO string (UTC, deterministic). */
export function parseLmeDate(raw: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\D+(\d{2}):(\d{2})/.exec(raw ?? '');
  if (!m) return new Date(0).toISOString();
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
}

interface RawLmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: unknown;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: unknown }>>;
}

export async function loadLongMemEval(path: string): Promise<LmeQuestion[]> {
  const raw = JSON.parse(await fs.readFile(path, 'utf-8')) as RawLmeQuestion[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`LongMemEval loader: no questions in ${path}`);
  }
  return raw.map((q) => ({
    questionId: q.question_id,
    questionType: q.question_type,
    question: q.question,
    answer: q.answer == null ? '' : String(q.answer),
    questionDateIso: parseLmeDate(q.question_date),
    isAbstention: q.question_id.endsWith('_abs'),
    sessions: q.haystack_sessions.map((turns, i) => ({
      sessionId: q.haystack_session_ids[i] ?? `s${i}`,
      dateIso: parseLmeDate(q.haystack_dates[i] ?? ''),
      turns: turns
        .filter((t) => typeof t.content === 'string' && t.content.trim())
        .map((t) => ({ role: t.role, content: String(t.content) })),
    })),
  }));
}
