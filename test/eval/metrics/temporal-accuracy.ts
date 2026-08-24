/**
 * Temporal exact-day accuracy, per locale.
 *
 * Every locale writes the same calendar day differently — order
 * (day-first vs year-first), month names ("März" / "marzo" / "марта"),
 * native digits ("٣" / "3"). The extractor must resolve all of them to
 * the same ISO day. This metric compares the predicted resolved day to
 * the gold day, EXACT match only — an off-by-one (timezone slip, wrong
 * month parse) is the exact failure mode the per-locale split surfaces.
 *
 * Pure — the caller resolves the expression to a date; this only scores.
 */

export interface TemporalRecord {
  /** The resolved day the system produced (ISO or parseable), or null. */
  predictedDate: string | null;
  /** Gold calendar day, YYYY-MM-DD. */
  goldDate: string;
  /** Locale/lang tag for the per-locale split. */
  locale: string;
}

/** Normalize any parseable date to a YYYY-MM-DD UTC day, or null. */
function toDay(value: string | null): string | null {
  if (value === null) return null;
  // Already a bare YYYY-MM-DD — take it as UTC to avoid a tz round-trip.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Share of records whose predicted day equals the gold day. null on empty. */
export function temporalExactDayAccuracy(records: TemporalRecord[]): number | null {
  if (records.length === 0) return null;
  let correct = 0;
  for (const r of records) {
    const predicted = toDay(r.predictedDate);
    if (predicted !== null && predicted === toDay(r.goldDate)) correct++;
  }
  return correct / records.length;
}

/** Per-locale accuracy, sorted by locale for stable reporting. */
export function temporalAccuracyByLocale(
  records: TemporalRecord[],
): Array<{ locale: string; accuracy: number; n: number }> {
  const byLocale = new Map<string, TemporalRecord[]>();
  for (const r of records) {
    byLocale.set(r.locale, [...(byLocale.get(r.locale) ?? []), r]);
  }
  return [...byLocale.entries()]
    .map(([locale, rows]) => ({
      locale,
      accuracy: temporalExactDayAccuracy(rows) ?? 0,
      n: rows.length,
    }))
    .sort((a, b) => a.locale.localeCompare(b.locale));
}
