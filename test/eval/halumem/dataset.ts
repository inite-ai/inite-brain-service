/**
 * HaluMem-Medium / HaluMem-Long records (huggingface.co/datasets/
 * IAAR-Shanghai/HaluMem), read from a downloaded JSONL — the data is
 * CC BY-NC-ND 4.0 and is never committed here. Field names are the
 * dataset's own.
 */
import { readFileSync } from 'node:fs';

export interface HaluMemTurn {
  role: 'user' | 'assistant';
  content: string;
  /** "Sep 04, 2025, 18:42:18" */
  timestamp: string;
}

export interface HaluMemPoint {
  memory_content: string;
  memory_type: string;
  /** The dataset stores booleans as "True" / "False". */
  is_update: string;
  original_memories: string[];
  importance: number;
  /** 'system' | 'interference' | … — interference points must NOT be remembered. */
  memory_source: string;
}

export interface HaluMemQuestion {
  question: string;
  answer: string;
  evidence: Array<{ memory_content: string }>;
  difficulty: string;
  question_type: string;
}

export interface HaluMemSession {
  start_time: string;
  dialogue: HaluMemTurn[];
  memory_points: HaluMemPoint[];
  questions?: HaluMemQuestion[];
  is_generated_qa_session?: boolean;
}

export interface HaluMemUser {
  uuid: string;
  persona_info: string;
  sessions: HaluMemSession[];
}

/**
 * The slice a run evaluates: the first `users` users, and of each the
 * first `sessions` sessions — in order, because a session's updates and
 * questions assume every earlier session was written. 0 = all.
 */
export function loadHaluMem(
  path: string,
  slice: { users: number; sessions: number },
): HaluMemUser[] {
  const users = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HaluMemUser);
  return (slice.users > 0 ? users.slice(0, slice.users) : users).map((u) => ({
    ...u,
    sessions: slice.sessions > 0 ? u.sessions.slice(0, slice.sessions) : u.sessions,
  }));
}

/** The user's name from persona_info ("…Name: Martin Mark; Gender: …"), as the toolkit reads it. */
export function userNameOf(personaInfo: string): string {
  const m = /Name:\s*(.*?); Gender:/.exec(personaInfo);
  if (!m) throw new Error('HaluMem: no name in persona_info');
  return m[1]!.trim();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 04, 2025, 18:42:18" → ISO, read as UTC (the toolkit's `%b %d, %Y, %H:%M:%S` + UTC). */
export function haluMemTime(s: string): string {
  const m = /^([A-Z][a-z]{2}) (\d{2}), (\d{4}), (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || month < 0) throw new Error(`HaluMem: unparseable time "${s}"`);
  return new Date(
    Date.UTC(Number(m[3]), month, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6])),
  ).toISOString();
}

/**
 * A session as the chat document brain ingests: one speaker line per
 * turn, the user under their name and the assistant as "Assistant" —
 * the transcript shape the document path cuts into turns
 * (src/documents/document-turns.ts). Newlines inside a turn are folded
 * so a turn stays one speaker line.
 */
export function sessionTranscript(session: HaluMemSession, userName: string): string {
  return session.dialogue
    .map(
      (t) =>
        `${t.role === 'user' ? userName : 'Assistant'}: ${t.content.replace(/\s*\n+\s*/g, ' ')}`,
    )
    .join('\n');
}

/** The dialogue as the accuracy judge reads it (evaluation.py dialogue_str). */
export function judgeDialogue(session: HaluMemSession): string {
  const out: string[] = [];
  for (const t of session.dialogue) {
    out.push(`[${t.timestamp}]${t.role}: ${t.content}`);
    if (t.role === 'assistant') out.push('');
  }
  return out.join('\n');
}
