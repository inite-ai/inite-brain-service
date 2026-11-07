/**
 * The affect reading (#909 step 4): what one model call is asked, and how
 * its answer is checked before anything is written. Pure — the server pass
 * (AffectReaderService) and the connected agent (harness work kind
 * `affect_reading`) send the same request and pass the answer through the
 * same parser.
 *
 * APPROACH. An appraisal reading of the person's own words, in context:
 * an emotion is about something (the appraisal target), it is read from a
 * span the reader can quote, and the default is to observe nothing.
 *  - Valence is the dimension text carries; arousal is not asked for
 *    (LLM arousal judgements track human ratings at r≈0.2–0.3 against
 *    0.5–0.7 for valence — GoEmotions/EmoBank calibration, 2025).
 *  - The label is coarse — Ekman's six or neutral, the GoEmotions
 *    taxonomy's own mapping — because a fine label on a short span is
 *    rarely agreed by two human readers either.
 *  - Abstention is the doctrine: a neutral turn, a feeling the person
 *    reports about someone else, a quoted or hypothetical one, and an
 *    ironic surface all yield nothing. A false observation about how a
 *    person feels is worse than a missed one.
 *  - The quote must be the person's exact words; a reading that cannot
 *    point at them is dropped by the parser, never repaired.
 */
export const AFFECT_READER_VERSION = 'affect-reader-v1';

export const AFFECT_LABELS = [
  'anger',
  'disgust',
  'fear',
  'joy',
  'sadness',
  'surprise',
  'neutral',
] as const;
export type AffectLabel = (typeof AFFECT_LABELS)[number];

/** Most observations one turn can yield: a turn is a few sentences. */
const MAX_PER_TURN = 3;
const MAX_TARGET_CHARS = 120;

/** One turn of the conversation the reading sees. */
export interface AffectTurn {
  /** Stable handle in the request: t1, t2, … */
  handle: string;
  speaker: string;
  /** Whether this turn is the person's own — the only turns read. */
  own: boolean;
  text: string;
  occurredAt: string;
}

export interface AffectObservationDraft {
  handle: string;
  quote: string;
  spanStart: number;
  spanEnd: number;
  valence: number;
  label: AffectLabel;
  target?: string;
  confidence: number;
}

export const AFFECT_READING_SYSTEM = `You read how ONE PERSON seemed to feel, from their own words in a conversation.

READ only the turns marked OWN — the person's own words. Other turns are context: they explain what the person is reacting to, and they are never read for feeling.

For each OWN turn, report an observation for every span where the person expresses how they feel — or none. Most turns express nothing, and then the answer for them is empty. A false observation about how a person feels is worse than a missed one.

Do NOT report:
- a feeling the person describes in someone else ("my wife is furious");
- a feeling quoted, imagined or hypothetical ("if I failed I'd be devastated", "he said 'I'm thrilled'");
- the literal surface of irony or sarcasm ("oh great, another Monday" is not joy);
- politeness and formulas ("thanks!", "sorry to bother you", "haha");
- an opinion about a thing with no feeling in it ("the API is slow").

For each observation:
- quote: the person's EXACT words that carry the feeling, copied character for character from the turn (a few words to one sentence);
- valence: -1 (very unpleasant) … 0 … +1 (very pleasant), how the person feels, not how the topic sounds;
- label: one of anger, disgust, fear, joy, sadness, surprise, neutral — the closest; frustration and irritation are anger, worry and anxiety are fear, tiredness with low mood is sadness, relief and pride are joy;
- target: what the feeling is about, in a few words ("the weigh-in", "her new job"), or null when the words do not say;
- confidence: the probability that a careful human reader of the same words would agree with this reading (label and sign of valence). Use the whole range: 0.9 only when the words leave no doubt.`;

/** The user message: the person, then the conversation with OWN marks. */
export function affectReadingUser(person: string, turns: readonly AffectTurn[]): string {
  const lines = turns.map(
    (t) => `[${t.handle}] ${t.own ? 'OWN' : 'context'} · ${t.speaker} · ${t.occurredAt}\n${t.text}`,
  );
  return `THE PERSON: ${person}\n\nCONVERSATION:\n${lines.join('\n\n')}`;
}

/** Strict JSON schema of the answer. */
export const AFFECT_READING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          turn: { type: 'string', description: 'The OWN turn handle, e.g. "t3".' },
          quote: { type: 'string' },
          valence: { type: 'number', minimum: -1, maximum: 1 },
          label: { type: 'string', enum: [...AFFECT_LABELS] },
          target: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['turn', 'quote', 'valence', 'label', 'target', 'confidence'],
      },
    },
  },
  required: ['observations'],
};

/**
 * The answer, checked: only OWN turns of this request, a quote found
 * verbatim in the turn (its span located there), values in range, at
 * most MAX_PER_TURN per turn, no duplicate spans. Anything else is
 * dropped — never repaired into something the reader did not say.
 */
export function parseAffectReading(
  raw: unknown,
  turns: readonly AffectTurn[],
): AffectObservationDraft[] {
  const list = (raw as { observations?: unknown } | null)?.observations;
  if (!Array.isArray(list)) return [];
  const byHandle = new Map(turns.map((t) => [t.handle, t]));
  const perTurn = new Map<string, number>();
  const seen = new Set<string>();
  const out: AffectObservationDraft[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const turn = typeof item?.turn === 'string' ? byHandle.get(item.turn) : undefined;
    if (!turn || !turn.own) continue;
    const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
    if (!quote) continue;
    const at = turn.text.indexOf(quote);
    if (at < 0) continue;
    const values = checkedValues(item);
    if (!values) continue;
    const { valence, confidence, label } = values;
    const spanStart = [...turn.text.slice(0, at)].length;
    const spanEnd = spanStart + [...quote].length;
    const key = `${turn.handle}:${spanStart}:${spanEnd}`;
    if (seen.has(key)) continue;
    const count = perTurn.get(turn.handle) ?? 0;
    if (count >= MAX_PER_TURN) continue;
    seen.add(key);
    perTurn.set(turn.handle, count + 1);
    const target =
      typeof item.target === 'string' && item.target.trim()
        ? item.target.trim().slice(0, MAX_TARGET_CHARS)
        : undefined;
    out.push({
      handle: turn.handle,
      quote,
      spanStart,
      spanEnd,
      valence,
      label,
      ...(target ? { target } : {}),
      confidence,
    });
  }
  return out;
}

/** Valence, confidence and label in range — or null. */
function checkedValues(
  item: Record<string, unknown>,
): { valence: number; confidence: number; label: AffectLabel } | null {
  const valence = num(item.valence);
  const confidence = num(item.confidence);
  if (valence === null || valence < -1 || valence > 1) return null;
  if (confidence === null || confidence < 0 || confidence > 1) return null;
  if (!(AFFECT_LABELS as readonly string[]).includes(item.label as string)) return null;
  const label = item.label as AffectLabel;
  // A neutral label with no valence is the abstention said out loud.
  if (label === 'neutral' && Math.abs(valence) < 0.05) return null;
  return { valence, confidence, label };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
