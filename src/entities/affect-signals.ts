/**
 * How a person has seemed to feel, as the relationship context serves it
 * (#909 step 5) — signals at a time, never their current state.
 *
 * The doctrine is the relationship layer's §2.3: an inference about how a
 * person feels is an observation with its time, its words and its
 * confidence. `state` keeps answering from what the person SAID; this
 * section never feeds it. Brain reports; the agent decides what to do.
 *
 * BASELINE. People differ in how they write — a terse person's neutral
 * reads as cold to an absolute scale — so each window is reported beside
 * the person's own mean over everything kept (the retention window), and
 * the recent week as its difference from that mean. Means are weighted by
 * the reading's confidence (a reading that would be disputed counts less).
 * Every number carries its `n`: whether 3 observations make a trend is
 * the reader's call, not a threshold here.
 *
 * Pure: rows in, signals out — the read lives in EntitiesService.
 */

/** Observations listed individually: the last two weeks, newest first. */
const RECENT_DAYS = 14;
const RECENT_MAX = 10;
/** The "lately" window compared with the baseline. */
const WEEK_MS = 7 * 24 * 3600_000;
/** Weekly means reported, newest last. */
const TREND_WEEKS = 4;

export interface AffectObservationRow {
  id: unknown;
  observedAt: string | Date;
  /** Text readings carry valence and label; voice readings (#916) arousal. */
  valence?: number | null;
  label?: string | null;
  arousal?: number | null;
  modality?: string | null;
  target?: string | null;
  quote?: string | null;
  confidence: number;
}

export interface AffectSignalItem {
  observationId: string;
  at: string;
  /** text | voice. */
  modality: 'text' | 'voice';
  valence?: number;
  label?: string;
  /** Voice: 0 calm … 1 agitated. */
  arousal?: number;
  about?: string;
  /** Text: the person's exact words it was read from. */
  quote?: string;
  confidence: number;
}

export interface AffectWindow {
  /** Confidence-weighted mean valence, −1..1. */
  meanValence: number;
  n: number;
}

export interface AffectSignals {
  /** Always 'inferred': read from the person's words, never said by them. */
  kind: 'inferred';
  recent: AffectSignalItem[];
  /** The person's own mean valence over every kept text reading (absent: voice only). */
  baseline?: AffectWindow & { since: string };
  /** The last seven days, and how far they sit from the baseline. */
  lastWeek?: AffectWindow & { deviation: number };
  /** Weekly means, oldest first, weeks with observations only. */
  weekly: Array<AffectWindow & { weekStart: string }>;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
const round = (x: number): number => Math.round(x * 1000) / 1000 || 0;

/** Confidence-weighted mean valence over the rows that carry valence (text readings). */
function window(rows: readonly AffectObservationRow[]): AffectWindow | null {
  let weight = 0;
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    if (typeof r.valence !== 'number') continue;
    weight += r.confidence;
    sum += r.valence * r.confidence;
    n += 1;
  }
  if (n === 0 || weight === 0) return null;
  return { meanValence: round(sum / weight), n };
}

/** Monday 00:00 UTC of the week holding `t`. */
function weekStart(t: number): number {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

export function shapeAffectSignals(
  rows: readonly AffectObservationRow[],
  now: Date,
): AffectSignals | null {
  if (rows.length === 0) return null;
  const baseline = window(rows);
  const at = (r: AffectObservationRow) => new Date(r.observedAt).getTime();
  const sorted = [...rows].sort((a, b) => at(b) - at(a));
  const nowMs = now.getTime();
  const recent = sorted
    .filter((r) => nowMs - at(r) <= RECENT_DAYS * 24 * 3600_000)
    .slice(0, RECENT_MAX)
    .map((r): AffectSignalItem => ({
      observationId: String(r.id),
      at: iso(r.observedAt),
      modality: r.modality === 'voice' ? 'voice' : 'text',
      ...(typeof r.valence === 'number' ? { valence: r.valence } : {}),
      ...(r.label ? { label: r.label } : {}),
      ...(typeof r.arousal === 'number' ? { arousal: r.arousal } : {}),
      ...(r.target ? { about: r.target } : {}),
      ...(r.quote ? { quote: r.quote } : {}),
      confidence: r.confidence,
    }));
  const week = window(sorted.filter((r) => nowMs - at(r) <= WEEK_MS));
  const byWeek = new Map<number, AffectObservationRow[]>();
  for (const r of sorted) {
    const w = weekStart(at(r));
    byWeek.set(w, [...(byWeek.get(w) ?? []), r]);
  }
  const weekly = [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-TREND_WEEKS)
    .flatMap(([w, rs]) => {
      const win = window(rs);
      return win ? [{ weekStart: new Date(w).toISOString(), ...win }] : [];
    });
  return {
    kind: 'inferred',
    recent,
    ...(baseline
      ? { baseline: { ...baseline, since: iso(sorted[sorted.length - 1]!.observedAt) } }
      : {}),
    ...(week && baseline
      ? { lastWeek: { ...week, deviation: round(week.meanValence - baseline.meanValence) } }
      : {}),
    weekly,
  };
}

/** Risk signals listed: the last thirty days, newest first. */
const SAFETY_DAYS = 30;
const SAFETY_MAX = 10;

export interface RiskSignalRow {
  id: unknown;
  observedAt: string | Date;
  level: 'concern' | 'urgent';
  quote: string;
  confidence: number;
}

/**
 * #916: risk of suicide or self-harm read from the person's words, for the
 * operator's protocol — the last thirty days, newest first, with the words
 * and the level. Brain reports; the agent's protocol decides (a referral,
 * a check-in). Never fed into `state`.
 */
export interface SafetySignals {
  kind: 'inferred';
  signals: Array<{
    signalId: string;
    at: string;
    level: 'concern' | 'urgent';
    quote: string;
    confidence: number;
  }>;
  /** The most recent urgent signal, when any falls in the window. */
  lastUrgentAt?: string;
}

export function shapeSafetySignals(
  rows: readonly RiskSignalRow[],
  now: Date,
): SafetySignals | null {
  const at = (r: RiskSignalRow) => new Date(r.observedAt).getTime();
  const recent = rows
    .filter((r) => now.getTime() - at(r) <= SAFETY_DAYS * 24 * 3600_000)
    .sort((a, b) => at(b) - at(a));
  if (recent.length === 0) return null;
  const urgent = recent.find((r) => r.level === 'urgent');
  return {
    kind: 'inferred',
    signals: recent.slice(0, SAFETY_MAX).map((r) => ({
      signalId: String(r.id),
      at: iso(r.observedAt),
      level: r.level,
      quote: r.quote,
      confidence: r.confidence,
    })),
    ...(urgent ? { lastUrgentAt: iso(urgent.observedAt) } : {}),
  };
}
