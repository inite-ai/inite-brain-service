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
 *   DELETE → `{ delete: "<record id>" }`                ← older builds, and
 *          → `{ delete: { id: "<record id>", original: { …pre-image… } } }`
 *            under INCLUDE ORIGINAL on 3.2.4 — an OBJECT, not a string.
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
  // DELETE: a bare id string (older builds) or `{ id, original }` (3.2.4 with
  // INCLUDE ORIGINAL). The post-image row is gone either way.
  if (typeof i.delete === 'string') return i.delete;
  if (i.delete && typeof i.delete === 'object') {
    const id = (i.delete as Record<string, unknown>).id;
    if (id != null) return String(id);
  }
  const row = changefeedRow(item);
  return row?.id ? String(row.id) : null;
}

/**
 * Operation tag for a changefeed item, derived from the SAME shape rules as
 * `changefeedRow` so no consumer re-invents them (the drain used to take
 * `Object.keys(item)[0]`, which mislabels a CREATE as `update` and an UPDATE
 * as `current` depending on key order). Matches the SurrealDB SHOW CHANGES
 * tag set that migration 0023 documents on `audit_event.op`.
 */
export function changefeedOp(item: unknown): 'create' | 'update' | 'delete' | 'define' | 'unknown' {
  if (!item || typeof item !== 'object') return 'unknown';
  const i = item as Record<string, unknown>;
  // DELETE: id string (older) or `{ id, original }` (3.2.4 INCLUDE ORIGINAL).
  if (i.delete != null) return 'delete';
  // UPDATE carries the post-image under `current` (with a reverse patch array
  // under `update`); CREATE carries the row directly under `update`.
  if (i.current && typeof i.current === 'object') return 'update';
  if (i.update && typeof i.update === 'object' && !Array.isArray(i.update)) return 'create';
  if ('define_table' in i) return 'define';
  return 'unknown';
}
