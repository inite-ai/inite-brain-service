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
  valence: number;
  label: string;
  target?: string | null;
  quote: string;
  confidence: number;
}

export interface AffectSignalItem {
  observationId: string;
  at: string;
  valence: number;
  label: string;
  about?: string;
  /** The person's exact words it was read from. */
  quote: string;
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
  /** The person's own mean over every kept observation. */
  baseline: AffectWindow & { since: string };
  /** The last seven days, and how far they sit from the baseline. */
  lastWeek?: AffectWindow & { deviation: number };
  /** Weekly means, oldest first, weeks with observations only. */
  weekly: Array<AffectWindow & { weekStart: string }>;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
const round = (x: number): number => Math.round(x * 1000) / 1000 || 0;

function window(rows: readonly AffectObservationRow[]): AffectWindow | null {
  let weight = 0;
  let sum = 0;
  for (const r of rows) {
    weight += r.confidence;
    sum += r.valence * r.confidence;
  }
  if (rows.length === 0 || weight === 0) return null;
  return { meanValence: round(sum / weight), n: rows.length };
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
  const baseline = window(rows);
  if (!baseline) return null;
  const at = (r: AffectObservationRow) => new Date(r.observedAt).getTime();
  const sorted = [...rows].sort((a, b) => at(b) - at(a));
  const nowMs = now.getTime();
  const recent = sorted
    .filter((r) => nowMs - at(r) <= RECENT_DAYS * 24 * 3600_000)
    .slice(0, RECENT_MAX)
    .map((r) => ({
      observationId: String(r.id),
      at: iso(r.observedAt),
      valence: r.valence,
      label: r.label,
      ...(r.target ? { about: r.target } : {}),
      quote: r.quote,
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
    .map(([w, rs]) => ({ weekStart: new Date(w).toISOString(), ...window(rs)! }));
  return {
    kind: 'inferred',
    recent,
    baseline: { ...baseline, since: iso(sorted[sorted.length - 1]!.observedAt) },
    ...(week
      ? { lastWeek: { ...week, deviation: round(week.meanValence - baseline.meanValence) } }
      : {}),
    weekly,
  };
}
