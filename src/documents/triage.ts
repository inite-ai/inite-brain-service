import type { DecisionService } from '../ai/decisions/decision.service';
import type { DecisionAnswer } from '../ai/decisions/decision.types';

/**
 * D1 — the first, cheap read of captured text: what it is worth reading
 * deeply (docs/roadmap/raw-processing-triggers-2026-09.md §4.1).
 *
 * One decision-plane request per waiting text — a standalone document, or
 * a conversation's unread turns rendered together (a turn alone says
 * little) — with five noul questions and the salience rubric of the
 * importance-scoring design, all answered against the same state in
 * parallel: a fraction of a cent, two orders below a full extraction.
 *
 * The stamp decides WHEN and HOW DEEP the text is read (read-depth.ts,
 * extraction-batch.service.ts): an urgent text is read at once, noise is
 * kept raw until something asks for it, routine text is read with one
 * sample. Asymmetric: an unanswered question reads as "maybe", and a text
 * with no stamp — the lane off, unkeyed or failing — is read in full, as
 * it was before triage existed.
 */

/** Stamp version — bumped when the questions change meaning. */
export const TRIAGE_VERSION = 1;

/** The plane reads what one extraction call reads, and no more. */
const TEXT_CHARS = 12_000;

export interface TriageStamp {
  v: number;
  at: string;
  /** P(true) for each question. */
  durable: number;
  change: number;
  instruction: number;
  correction: number;
  identity: number;
  /** 0 incidental · 1 routine · 2 notable · 3 identity-central. */
  salience: number;
}

const NOUL = {
  durable: {
    instructions:
      'Does the text state something about a person, organisation, thing, plan, decision or state that would still be worth knowing next week?',
    criteria: {
      true: 'Yes — a fact, a decision, a plan, a preference, a state, a relation, a date that matters later.',
      false:
        'No — only greetings, acknowledgements, filler, or the logistics of this very exchange.',
    },
  },
  change: {
    instructions:
      'Does the text say that something previously true is no longer true, or has changed (moved, replaced, ended, sold, switched, rescheduled)?',
    criteria: {
      true: 'Yes — a transition from an earlier state or value to a new one.',
      false: 'No change of an earlier state is stated.',
    },
  },
  instruction: {
    instructions:
      'Does the text give the assistant a standing instruction or preference about how to act, answer, write or format from now on ("remember…", "always…", "never…", "from now on…")?',
    criteria: {
      true: 'Yes — a rule meant to govern later answers.',
      false: 'No standing instruction (a one-off request or task is not one).',
    },
  },
  correction: {
    instructions:
      'Does the text correct or retract something said or recorded earlier ("no, actually…", "I was wrong…", "that is not right…")?',
    criteria: {
      true: 'Yes — an earlier statement is corrected or withdrawn.',
      false: 'Nothing earlier is corrected.',
    },
  },
  identity: {
    instructions:
      'Does the speaker state who they are — their name, role, job, family, home or another identity-central fact about themselves?',
    criteria: {
      true: 'Yes — a self-identifying statement.',
      false: 'No self-identifying statement.',
    },
  },
} as const;

/** The salience rubric's levels, 0..3 (importance-scoring design). */
export const SALIENCE_LEVELS = [
  'incidental detail (small talk, one-off logistics)',
  'routine fact — the neutral default',
  'notable: decisions, changes, plans, recurring topics',
  'identity-central: job, family, health, home, long-term goals',
];

const SALIENCE = {
  type: 'score' as const,
  instructions:
    'How important is what the text states, for a long-lived memory of this person or team?',
  criteria: SALIENCE_LEVELS,
};

export async function triageText(
  decisions: DecisionService | undefined,
  text: string,
): Promise<TriageStamp | null> {
  if (!decisions?.enabled('triage') || !text.trim()) return null;
  const questions = {
    ...Object.fromEntries(
      Object.entries(NOUL).map(([k, q]) => [k, { type: 'noul' as const, ...q }]),
    ),
    salience: SALIENCE,
  };
  const res = await decisions.decide('triage', {
    state: `TEXT:\n${text.slice(0, TEXT_CHARS)}`,
    questions,
  });
  if (!res) return null;
  const p = (key: keyof typeof NOUL): number => noulOf(res.answers[key]);
  const salience = res.answers.salience;
  return {
    v: TRIAGE_VERSION,
    at: new Date().toISOString(),
    durable: p('durable'),
    change: p('change'),
    instruction: p('instruction'),
    correction: p('correction'),
    identity: p('identity'),
    salience: salienceLevel(salience),
  };
}

/**
 * The rubric level the plane found most likely. `score` is the expected
 * value over the levels (2.86), not a level, so the level is the argmax of
 * the distribution, read back to our rubric through its legend (the
 * level's own description) rather than by assuming how the plane numbers
 * levels. Unreadable → routine, the rubric's neutral default.
 */
function salienceLevel(answer: DecisionAnswer | undefined): number {
  if (answer?.type !== 'score') return 1;
  const top = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
  const described = top === undefined ? undefined : answer.legend[top];
  const level = described === undefined ? -1 : SALIENCE.criteria.indexOf(described);
  return level >= 0 ? level : 1;
}

/** An unanswered question reads as "maybe" — never as "no". */
function noulOf(answer: DecisionAnswer | undefined): number {
  return answer?.type === 'noul' ? answer.noul : 0.5;
}
