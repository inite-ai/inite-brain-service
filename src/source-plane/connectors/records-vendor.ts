/**
 * What every vendor connector on the records contract shares when it
 * turns a vendor row into a record envelope: attributes are flat
 * scalars with the empties dropped, timestamps are ISO 8601 in UTC
 * whatever the vendor's spelling (a space for the `T`, an offset, epoch
 * seconds or milliseconds).
 */

export type Scalar = string | number | boolean | null;

/** Keeps the defined, non-empty scalars — a vendor's `null`s and `''`s are "no value", not a fact. */
export function scalars(raw: Record<string, Scalar | undefined>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * ISO 8601 (UTC) from a vendor timestamp: an ISO string with or without
 * an offset (none = UTC), `YYYY-MM-DD HH:MM:SS` (Pipedrive's form, UTC),
 * or seconds (Kommo) / milliseconds (HubSpot) since the epoch. A bare
 * date stays a date; what does not parse is returned as it came.
 */
export function isoOf(v: string | number): string {
  if (typeof v === 'number') {
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
  }
  if (/^\d+$/.test(v)) return isoOf(Number(v));
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(v);
  const iso = v.includes('T') ? v : v.replace(' ', 'T');
  const d = new Date(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}
