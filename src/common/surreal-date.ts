/**
 * A datetime column as an ISO string, whatever shape the driver handed
 * back. surrealdb 2.2 returns its own DateTime object where 1.x returned
 * a string, and every `row.validFrom.slice(0, 10)` written against the old
 * shape threw `slice is not a function` — the nightly dreams job failed
 * whole on the first competing pair (found on a local stand, 2026-10-29).
 */
export function isoString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  if (v && typeof (v as { toISOString?: unknown }).toISOString === 'function') {
    return (v as { toISOString: () => string }).toISOString();
  }
  return String(v ?? '');
}

/** The UTC calendar day of a datetime column ("YYYY-MM-DD"). */
export function isoDay(v: unknown): string {
  return isoString(v).slice(0, 10);
}
