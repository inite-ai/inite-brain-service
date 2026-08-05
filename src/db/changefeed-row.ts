/**
 * Read the full row out of one `SHOW CHANGES` item.
 *
 * ⚠️ THE SHAPE IS NOT WHAT IT LOOKS LIKE. All three knowledge tables carry
 * `CHANGEFEED … INCLUDE ORIGINAL`, and that changes the item layout by
 * operation — verified empirically against SurrealDB 3.2.1:
 *
 *   CREATE → `{ update: { …full row… } }`
 *   UPDATE → `{ current: { …full row… },
 *              update: [ { op, path, value }, … ] }`   ← a PATCH ARRAY
 *   DELETE → `{ delete: "<record id>" }`
 *
 * So on an UPDATE, `item.update` is an array of diff operations, not a row —
 * `item.update.id` silently reads `undefined`, and any consumer keyed on it
 * sees creates only and misses every update. That is a whole class of
 * invisible bug: the drain runs, advances its cursor, reports success, and
 * does nothing.
 *
 * (The patch ops are also REVERSED — they describe how to get from the current
 * row back to the original, which is what "include original" means here. Do
 * not read them as forward changes.)
 *
 * Returns null for deletes and anything malformed.
 */
export function changefeedRow(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== 'object') return null;
  const i = item as Record<string, unknown>;
  // UPDATE: the authoritative post-image.
  if (i.current && typeof i.current === 'object') {
    return i.current as Record<string, unknown>;
  }
  // CREATE: the row sits directly under `update`.
  if (i.update && typeof i.update === 'object' && !Array.isArray(i.update)) {
    return i.update as Record<string, unknown>;
  }
  return null;
}

/** Record id of a changefeed item, including deletes (where only the id exists). */
export function changefeedRecordId(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const i = item as Record<string, unknown>;
  if (typeof i.delete === 'string') return i.delete;
  const row = changefeedRow(item);
  return row?.id ? String(row.id) : null;
}
