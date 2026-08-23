import { promises as fs } from 'node:fs';

/**
 * BEAM loader (Tavakoli et al., ICLR 2026 — arXiv 2510.27246).
 *
 * Consumes the normalized JSON produced by scripts/fetch-beam-dataset.py
 * (the raw parquet carries Python-literal question strings and per-ability
 * gold keys; normalization happens there so this loader stays dumb).
 *
 * One conversation = one haystack (~100K/500K/1M tokens by split) probed
 * by 20 questions across ten memory abilities. The `abstention` ability is
 * the decline-to-answer subset — mirror of LongMemEval's `_abs`.
 */

export const BEAM_ABILITIES = [
  'abstention',
  'contradiction_resolution',
  'event_ordering',
  'information_extraction',
  'instruction_following',
  'knowledge_update',
  'multi_session_reasoning',
  'preference_following',
  'summarization',
  'temporal_reasoning',
] as const;

export interface BeamTurn {
  role: 'user' | 'assistant' | string;
  content: string;
}

export interface BeamSession {
  sessionId: string;
  dateIso: string;
  turns: BeamTurn[];
}

export interface BeamQuestion {
  questionId: string;
  ability: string;
  question: string;
  gold: string;
  difficulty: string;
  /** Judge key points (BEAM rubric + compliance indicators, folded). */
  rubric: string[];
  sourceChatIds: unknown[];
}

export interface BeamConversation {
  conversationId: string;
  split: string;
  category: string;
  title: string;
  sessions: BeamSession[];
  questions: BeamQuestion[];
}

export async function loadBeam(path: string): Promise<BeamConversation[]> {
  const raw = JSON.parse(await fs.readFile(path, 'utf-8')) as BeamConversation[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`BEAM loader: no conversations in ${path}`);
  }
  return raw;
}

/** Questions are undated upstream; probe a week after the last session. */
export function beamQuestionDateIso(conv: BeamConversation): string {
  const last = conv.sessions[conv.sessions.length - 1];
  const t = new Date(last?.dateIso ?? 0).getTime();
  return new Date(t + 7 * 24 * 3600 * 1000).toISOString();
}
