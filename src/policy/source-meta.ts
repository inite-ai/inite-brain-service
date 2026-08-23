/**
 * Sanitizer for operator metadata that rides onto facts as
 * `source.meta` — the projection ABAC source rules match with
 * `source.meta.<key>` conditions.
 *
 * Meta is OPERATOR VOCABULARY (data_class: pii, department: finance),
 * not free text: keys are snake_case identifiers, values are short
 * scalars, and the bag is small. Everything else is dropped (or, under
 * SOURCE_META_STRICT, rejected by the caller) — a 4 KB blob of prose
 * on `source` would bloat every retrieved row and invite prompt-shaped
 * garbage into a security-relevant match surface.
 */

export const SOURCE_META_MAX_KEYS = 16;
export const SOURCE_META_MAX_VALUE_CHARS = 256;
const META_KEY = /^[a-z][a-z0-9_]{0,63}$/;

export type SourceMeta = Record<string, string | number | boolean>;

export interface SanitizeMetaResult {
  meta?: SourceMeta;
  /** Human-readable reasons for every dropped entry (strict mode 400s on any). */
  dropped: string[];
}

export function sanitizeSourceMeta(raw: unknown): SanitizeMetaResult {
  if (raw === undefined || raw === null) return { dropped: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { dropped: ['meta must be an object of scalar values'] };
  }
  const dropped: string[] = [];
  const meta: SourceMeta = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!META_KEY.test(key)) {
      dropped.push(`key '${key}' is not snake_case (${META_KEY})`);
      continue;
    }
    const ok =
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= SOURCE_META_MAX_VALUE_CHARS);
    if (!ok) {
      dropped.push(
        `value of '${key}' must be a boolean, finite number, or string ≤${SOURCE_META_MAX_VALUE_CHARS} chars`,
      );
      continue;
    }
    if (kept >= SOURCE_META_MAX_KEYS) {
      dropped.push(`key '${key}' over the ${SOURCE_META_MAX_KEYS}-key cap`);
      continue;
    }
    meta[key] = value as string | number | boolean;
    kept += 1;
  }
  return { ...(kept > 0 ? { meta } : {}), dropped };
}
