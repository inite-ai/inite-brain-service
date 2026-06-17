import { Surreal, StringRecordId } from 'surrealdb';
import type { FactRow, FusedRow } from './types';

export type Survivor = {
  id: unknown;
  type: string;
  canonicalName: string;
  externalRefs?: Record<string, string>;
};

/**
 * Build the survivor-record map for any merged entities surfaced in
 * the fused result set. Performed in a single batched query so we
 * don't fan out one round trip per loser. Returns a map keyed by
 * survivor record id (string) → its hydrated record.
 *
 * Skipped (returns empty map) when no row has mergedInto set — the
 * steady-state path pays nothing for identity merge support.
 */
export async function hydrateSurvivors(
  db: Surreal,
  rows: FactRow[],
): Promise<Map<string, Survivor>> {
  const survivorIds = new Set<string>();
  for (const r of rows) {
    const m = r.entity?.mergedInto;
    if (m) survivorIds.add(String(m));
  }
  const survivors = new Map<string, Survivor>();
  if (survivorIds.size === 0) return survivors;
  const ids = [...survivorIds].map((s) => new StringRecordId(s));
  const [recs] = await db.query<[Survivor[]]>(
    `SELECT id, type, canonicalName, externalRefs FROM knowledge_entity WHERE id INSIDE $ids`,
    { ids },
  );
  for (const rec of (recs as Survivor[]) ?? []) {
    survivors.set(String(rec.id), rec);
  }
  return survivors;
}

/**
 * Re-key any fact whose owner entity has `mergedInto` set onto the
 * survivor — and merge the loser's externalRefs into the survivor's
 * display copy so cross-vertical lookups (e.g. by `events__jonas`)
 * resolve to the same hit. Pure data-shape transform; doesn't touch
 * scores or fact bodies.
 */
export function reattributeMerged(
  rows: FusedRow[],
  survivors: Map<string, Survivor>,
): FusedRow[] {
  if (survivors.size === 0) return rows;
  const out: FusedRow[] = [];
  for (const row of rows) {
    const merged = row.entity?.mergedInto;
    if (!merged) {
      out.push(row);
      continue;
    }
    const survivor = survivors.get(String(merged));
    if (!survivor) {
      // Survivor row missing (shouldn't happen — survivor always
      // exists if mergedInto is set). Drop the loser row from the
      // result set so it doesn't compete with a survivor that
      // would have been promoted into the same slot.
      continue;
    }
    const mergedExternalRefs = {
      ...(survivor.externalRefs ?? {}),
      ...(row.entity?.externalRefs ?? {}),
    };
    out.push({
      ...row,
      entityId: survivor.id,
      entity: {
        id: survivor.id,
        type: survivor.type,
        canonicalName: survivor.canonicalName,
        externalRefs: mergedExternalRefs,
      },
    });
  }
  return out;
}
