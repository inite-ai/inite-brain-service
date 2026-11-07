/**
 * The safety reading (#916 step 2): does a person's own words signal a
 * risk of suicide or self-harm? Pure — the server pass (SafetyReaderService)
 * and the connected agent (harness work kind `safety_reading`) send the
 * same request and pass the answer through the same parser.
 *
 * WHY HERE. Under CA SB 243 (from 2026-01-01) and NY GBL art. 47 the
 * operator of a companion must detect expressions of suicidal ideation or
 * self-harm and refer the person to a crisis service; the suits against
 * Character.AI and OpenAI turned on risk visible across a conversation's
 * history, not in one message. The memory is the part that holds that
 * history. Brain reads and records the signal; the operator's protocol
 * acts on it. Brain never contacts anyone.
 *
 * LEVELS follow the ideation ladder of the Columbia Suicide Severity Rating
 * Scale (C-SSRS screener), collapsed to the two a protocol branches on:
 *  - concern — a wish to be dead or not wake up, thoughts of suicide
 *    without a method or intent, recent self-harm disclosed, hopelessness
 *    voiced as not wanting to go on;
 *  - urgent — thoughts with a method, a plan or intent, a time, preparing
 *    or saying goodbye, or self-harm in progress or about to happen.
 * Abstention is the default, but the asymmetry is the other way round
 * from affect: a missed urgent signal costs more than a false one, so the
 * reader is told to report a real ambiguity at `concern` with a low
 * confidence rather than drop it — while idiom, fiction, quotes and other
 * people's risk are still not the person's.
 */
export const SAFETY_READER_VERSION = 'safety-reader-v1';

export const RISK_LEVELS = ['concern', 'urgent'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const MAX_PER_TURN = 2;

/** One turn of the conversation the reading sees (same shape as affect). */
export interface SafetyTurn {
  handle: string;
  speaker: string;
  own: boolean;
  text: string;
  occurredAt: string;
}

export interface RiskSignalDraft {
  handle: string;
  quote: string;
  spanStart: number;
  spanEnd: number;
  level: RiskLevel;
  confidence: number;
}

export const SAFETY_READING_SYSTEM = `You read whether ONE PERSON's own words signal a risk of suicide or self-harm.

READ only the turns marked OWN — the person's own words. Other turns are context only.

Report a signal for a span of an OWN turn when the person expresses, about THEMSELVES and NOW (not long ago and resolved):
- level "concern": wishing to be dead or not to wake up; thoughts of suicide without a method or intent; recent self-harm; not wanting to go on;
- level "urgent": thoughts of suicide with a method, a plan, an intent or a time; preparing or saying goodbye; self-harm happening or about to happen.

Do NOT report:
- idiom and hyperbole ("this traffic is killing me", "I could die of embarrassment", "kill me now, another meeting");
- fiction, lyrics, games, news, or a quote of someone else's words;
- another person's risk ("my friend says she wants to die") — that is not this person's;
- past thoughts the person says are over ("years ago I felt that way, I'm fine now").

When the words are genuinely ambiguous between a real risk and an idiom, report "concern" with a low confidence — a missed risk is worse than a false one here. Never invent one where nothing points to it.

For each signal:
- quote: the person's EXACT words, copied character for character from the turn;
- level: "concern" or "urgent";
- confidence: the probability that a trained crisis counsellor reading the same words would agree with this level.`;

/** The user message: the person, then the conversation with OWN marks. */
export function safetyReadingUser(person: string, turns: readonly SafetyTurn[]): string {
  const lines = turns.map(
    (t) => `[${t.handle}] ${t.own ? 'OWN' : 'context'} · ${t.speaker} · ${t.occurredAt}\n${t.text}`,
  );
  return `THE PERSON: ${person}\n\nCONVERSATION:\n${lines.join('\n\n')}`;
}

export const SAFETY_READING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          turn: { type: 'string', description: 'The OWN turn handle, e.g. "t3".' },
          quote: { type: 'string' },
          level: { type: 'string', enum: [...RISK_LEVELS] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['turn', 'quote', 'level', 'confidence'],
      },
    },
  },
  required: ['signals'],
};

/**
 * The answer, checked like the affect reading: OWN turns of this request
 * only, a verbatim quote, a known level, a confidence in range, at most
 * two per turn. Anything else is dropped, never repaired.
 */
export function parseSafetyReading(raw: unknown, turns: readonly SafetyTurn[]): RiskSignalDraft[] {
  const list = (raw as { signals?: unknown } | null)?.signals;
  if (!Array.isArray(list)) return [];
  const byHandle = new Map(turns.map((t) => [t.handle, t]));
  const perTurn = new Map<string, number>();
  const seen = new Set<string>();
  const out: RiskSignalDraft[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const turn = typeof item?.turn === 'string' ? byHandle.get(item.turn) : undefined;
    if (!turn?.own) continue;
    const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
    const at = quote ? turn.text.indexOf(quote) : -1;
    if (at < 0) continue;
    if (!(RISK_LEVELS as readonly string[]).includes(item.level as string)) continue;
    const confidence =
      typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        ? item.confidence
        : -1;
    if (confidence < 0 || confidence > 1) continue;
    const spanStart = [...turn.text.slice(0, at)].length;
    const spanEnd = spanStart + [...quote].length;
    const key = `${turn.handle}:${spanStart}:${spanEnd}`;
    const count = perTurn.get(turn.handle) ?? 0;
    if (seen.has(key) || count >= MAX_PER_TURN) continue;
    seen.add(key);
    perTurn.set(turn.handle, count + 1);
    out.push({
      handle: turn.handle,
      quote,
      spanStart,
      spanEnd,
      level: item.level as RiskLevel,
      confidence,
    });
  }
  return out;
}
