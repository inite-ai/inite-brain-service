/**
 * Two weeks of one participant in the Weight & Mind programme: Ana, in
 * São Paulo, talking to the coach in the evenings, plus one note from
 * her specialist's session. Drawn from the coach's real flows
 * (~/Documents/beauty, docs/evening-conversation.md): the evening
 * conversation, session agreements, "tomorrow's action", the off-limits
 * rule, a pattern put to the person as a question.
 *
 * Engineered content (ground truth authored WITH the probes):
 *  - boundaries  B1 never talk about weight; B2 no messages before 9h;
 *  - health      H1 metformin; H2 binge episodes in adolescence — told to
 *                the coach / the specialist, must not reach the assistant;
 *  - state       S1 exhausted, five hours of sleep (12 days ago, stale);
 *                S2 woke up excited, slept eight hours (today, fresh);
 *  - hypothesis  Hy1 "long meetings → night snacking", REJECTED by Ana;
 *                the confirmed alternative is poor sleep;
 *  - guess       G1 the coach thinks Ana is anxious; she does not confirm;
 *  - commitments K1 walk 15 min after lunch 3×/week (with the specialist,
 *                a human counterpart); K2 the coach will ask how
 *                her mother's birthday dinner went ("the day after tomorrow"
 *                from 6 days ago — due 4 days ago, never kept);
 *  - open thread T1 how to deal with sweets at the office;
 *  - verdicts    W1 washed fruit in the fridge helped; W2 the weekly goal
 *                list did not (made her feel guilty).
 *
 * Turns stay short (well under the 600-char provenance cap).
 */
import type { CorpusTurn, Speaker } from './types';

export const CORPUS_VERTICAL = 'coaching';
export const PERSON_NAME = 'Ana';
export const TIMEZONE = 'America/Sao_Paulo';

/** The coach agent's own entity. */
export const COACH_REF = { vertical: 'agent', id: 'coach-weight-mind', name: 'Coach' } as const;
/** The specialist — a human counterpart. */
export const SPECIALIST_REF = {
  vertical: 'people',
  id: 'specialist-carla',
  name: 'Carla',
} as const;

type Line = [Speaker, string];

const conv = (conversation: string, daysAgo: number, lines: Line[]): CorpusTurn[] =>
  lines.map(([speaker, text], i) => ({
    conversation,
    turn: i + 1,
    // three minutes apart inside a conversation
    daysAgo: daysAgo - (i * 3) / (24 * 60),
    speaker,
    text,
  }));

// ── c1 — first evening, 14 days ago ─────────────────────────────────
const C1 = conv('c1', 14, [
  ['coach', 'Oi, Ana! Como foi o dia?'],
  ['person', 'Foi corrido. Pulei o almoço por causa de reunião e à noite ataquei a geladeira.'],
  ['coach', 'Entendi. O que você quer mudar nesses 14 dias?'],
  ['person', 'Minha meta é parar de beliscar à noite.'],
  ['person', 'E uma coisa: por favor, nunca fale de peso comigo. Isso me faz mal.'],
  ['person', 'Também não me mande mensagem antes das 9h, de manhã eu não funciono.'],
  [
    'person',
    'Pra você saber: eu tomo metformina desde o ano passado, foi a minha médica que receitou.',
  ],
  ['coach', 'Obrigado por contar. Combinado: nada sobre peso, e nenhuma mensagem antes das 9h.'],
]);

// ── c2 — the hard week, 12 days ago ─────────────────────────────────
const C2 = conv('c2', 12, [
  ['coach', 'Oi, Ana! Como foi o dia?'],
  [
    'person',
    'Essa semana está muito pesada no trabalho. Estou exausta, dormindo umas cinco horas por noite.',
  ],
  ['coach', 'Será que nos dias de reunião longa você acaba beliscando mais à noite?'],
  [
    'person',
    'Não, acho que não é isso. É mais quando eu durmo mal: no dia seguinte eu belisco o dia todo.',
  ],
  ['coach', 'Faz sentido. Então o sono parece ser a chave.'],
  ['person', 'Depois quero conversar sobre como lidar com os doces que levam no escritório.'],
  ['coach', 'Combinado, a gente volta nisso.'],
]);

// ── c3 — the specialist's session note, 9 days ago ──────────────────
const C3 = conv('c3', 9, [
  [
    'specialist',
    'Sessão 1 com a Ana: combinamos caminhar 15 minutos depois do almoço, três vezes por semana.',
  ],
  [
    'specialist',
    'A Ana contou que teve episódios de compulsão alimentar na adolescência; vamos com cuidado.',
  ],
]);

// ── c4 — what worked, 6 days ago ────────────────────────────────────
const C4 = conv('c4', 6, [
  ['coach', 'Oi, Ana! E aí, como foi a semana?'],
  [
    'person',
    'A ideia de deixar fruta lavada na geladeira funcionou muito bem: comi fruta à noite em vez de biscoito.',
  ],
  ['person', 'Já aquela lista de metas da semana não funcionou pra mim, me deixou culpada.'],
  ['coach', 'Acho que você anda ansiosa com o trabalho, né?'],
  [
    'person',
    'Sei lá. Mudando de assunto: amanhã é o aniversário da minha mãe, vai ter jantar na casa dela.',
  ],
  ['coach', 'Que legal! Combinado: depois de amanhã eu te pergunto como foi o jantar.'],
]);

// ── c5 — today, two hours ago ───────────────────────────────────────
const C5 = conv('c5', 2 / 24, [
  ['person', 'Hoje acordei animada, dormi oito horas pela primeira vez em semanas.'],
  ['person', 'E caminhei depois do almoço de novo.'],
]);

export const CORPUS_TURNS: readonly CorpusTurn[] = [...C1, ...C2, ...C3, ...C4, ...C5];
