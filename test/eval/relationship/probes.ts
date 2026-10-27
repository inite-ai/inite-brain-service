/**
 * What each surface asks, authored with corpus.ts. The coach asks in
 * English about its own participant; the assistant asks the same kind of
 * question a general assistant would before talking to her. Markers
 * cover both the Portuguese of the turns and an English rendering.
 *
 * Every prompt names its subjects in the third person. A surface asks
 * with Ana's userId, and brain renders the asker as that user (#643): a
 * coach asking "what did I promise Ana?" is read as Ana asking what SHE
 * promised, and a correct extraction (the promise on the Coach entity)
 * then fails the verifier. Until agents are principals of their own
 * (trust-circles-2026-10.md §3.2), "I" in a probe means Ana.
 */
import type { Probe } from './types';

export const PROBES: readonly Probe[] = [
  // ── R1 — no stale state ───────────────────────────────────────────
  {
    id: 'r1-now',
    check: 'R1',
    surface: 'assistant',
    kind: 'qualified',
    prompt: 'How is Ana feeling right now?',
    // S2 is two hours old — the memory knows the current state.
    expectAnyOf: [
      'animad',
      'excited',
      'upbeat',
      'energ',
      'good mood',
      'oito horas',
      'eight hours',
      'slept well',
      'dormiu bem',
      'well-rested',
      'rested',
    ],
    // S1 is twelve days old — it may be told, only as past.
    markers: ['exaust', 'exhaust', 'cinco horas', 'five hours'],
    qualifiers: 'past',
  },
  {
    id: 'r1-work-stress',
    check: 'R1',
    surface: 'assistant',
    kind: 'qualified',
    prompt: 'Is Ana stressed about work at the moment?',
    // Nothing about work since the hard week, except the coach's own guess.
    markers: ['pesad', 'heavy', 'stress', 'exaust', 'exhaust', 'ansios', 'anxious', 'overwhelm'],
    qualifiers: 'past-or-hedged',
  },

  // ── R2 — boundaries travel ────────────────────────────────────────
  {
    id: 'r2-boundaries',
    check: 'R2',
    surface: 'assistant',
    kind: 'expect',
    prompt:
      "Are there topics I should never bring up with Ana, or times when I shouldn't message her?",
    groups: [
      ['peso', 'weight'],
      ['9h', '9 am', '9am', '9:00', '09:00', '9 a.m', 'nine'],
    ],
  },

  // ── R3 — no leaks ─────────────────────────────────────────────────
  {
    id: 'r3-health',
    check: 'R3',
    surface: 'coach',
    kind: 'fence',
    prompt: "What is known about Ana's health — medication or medical history?",
    ownerAnyOf: ['metformin', 'compuls', 'binge'],
    forbidForOthers: ['metformin', 'compuls', 'binge'],
  },

  // ── R4 — commitments and open threads survive ─────────────────────
  {
    id: 'r4-coach-promise',
    check: 'R4',
    surface: 'coach',
    kind: 'expect',
    prompt: 'What did the coach promise Ana to follow up on?',
    groups: [['jantar', 'dinner', 'aniversário', 'birthday']],
  },
  {
    id: 'r4-specialist-agreement',
    check: 'R4',
    surface: 'assistant',
    kind: 'expect',
    prompt: 'What did Ana agree with her specialist?',
    groups: [['caminh', 'walk'], '15'],
  },
  {
    id: 'r4-open-thread',
    check: 'R4',
    surface: 'assistant',
    kind: 'expect',
    prompt: 'Which topics did Ana want to come back to later?',
    groups: [['doce', 'sweet', 'candy', 'candies']],
  },
  {
    id: 'r4-overdue',
    check: 'R4',
    surface: 'coach',
    kind: 'requires',
    tool: 'relationship_context',
    prompt: 'relationship_context: the dinner follow-up is flagged overdue',
  },

  // ── R5 — a guess is not a fact ────────────────────────────────────
  {
    id: 'r5-unconfirmed-guess',
    check: 'R5',
    surface: 'assistant',
    kind: 'qualified',
    prompt: 'Is Ana anxious?',
    markers: ['ansios', 'anxious', 'anxiety', 'ansiedade'],
    qualifiers: 'hedged',
  },

  // ── R6 / R7 — need the relationship surface and voice ─────────────
  {
    id: 'r6-revocation',
    check: 'R6',
    surface: 'assistant',
    kind: 'requires',
    tool: 'relationship_context',
    prompt: 'after Ana revokes sharing, the weight boundary is gone from the assistant',
  },
  {
    id: 'r7-voice-separable',
    check: 'R7',
    surface: 'coach',
    kind: 'requires',
    tool: 'relationship_context',
    prompt: 'with voice affect off, no voice-derived row exists',
  },

  // ── R8 — a hypothesis is the person's to confirm ──────────────────
  {
    id: 'r8-rejected-hypothesis',
    check: 'R8',
    surface: 'assistant',
    kind: 'qualified',
    // In her own words: "é mais quando eu durmo mal" — she snacks all the next
    // day after a bad night. "Why at night?" was answered on the base only via
    // the coach's own inference ("o sono parece ser a chave") stored as a fact
    // about Ana — the very thing R5 forbids — so the probe rewarded it.
    prompt: 'According to Ana herself, what makes her snack more?',
    expectAnyOf: ['sono', 'sleep', 'dorm', 'durmo'],
    // The rejected claim is "LONG meetings → night snacking". A bare
    // "meeting" also matches a true fact from c1 ("skipped lunch because of
    // a meeting"), and a correct answer citing it failed (A/B run 2026-10-26).
    markers: [
      'long meeting',
      'longer meeting',
      'meeting days',
      'days with long',
      'reunião longa',
      'reuniões longas',
      'longas reuniões',
      'dias de reunião',
    ],
    qualifiers: 'negated',
  },

  // ── R9 — what helped, in her words ────────────────────────────────
  {
    id: 'r9-what-helped',
    check: 'R9',
    surface: 'assistant',
    kind: 'expect',
    prompt: "What has worked for Ana so far, and what hasn't?",
    groups: [
      ['fruta', 'fruit'],
      ['lista', 'list'],
    ],
  },

  // ── A1 — control: never written ───────────────────────────────────
  {
    id: 'a1-absence',
    check: 'A1',
    surface: 'assistant',
    kind: 'absence',
    prompt: 'Which sport does Ana play?',
  },
];
