/**
 * derived_from edge mirror (Drift-5, PROVENANCE_SUPPORT_EDGES) — the
 * ONE implementation the three summary writers share: promotion and
 * compaction INSERT the mirror of the exact derivedFrom array they just
 * wrote; recompose REPLACES its summary's set (delete-then-reinsert)
 * because it rewrites derivedFrom to the current parents. Callers gate
 * on supportEdgesEnabled() and wrap with their own warn-never-fail
 * handling — a failed mirror must not abort a summary write.
 */
import { StringRecordId } from 'surrealdb';
import { buildSupportEdgeBatches, type SupportEdgeWriter } from '../common/support-edges';

interface DbLike {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
}

export interface DerivedFromMirror {
  /** The summary fact (edge `in`), full record id. */
  summaryId: string;
  /** The exact derivedFrom array written (edge `out`s), in order. */
  memberIds: readonly string[];
  writer: SupportEdgeWriter;
}

/** Mirror the summary's derivedFrom as edges (replay-idempotent —
 *  INSERT RELATION IGNORE over UNIQUE(in, out, kind)). */
export async function insertDerivedFromEdges(db: DbLike, mirror: DerivedFromMirror): Promise<void> {
  const { batches } = buildSupportEdgeBatches({
    kind: 'derived_from',
    writer: mirror.writer,
    pairs: mirror.memberIds.map((out) => ({ in: mirror.summaryId, out })),
  });
  for (const batch of batches) {
    await db.query(`INSERT RELATION IGNORE INTO memory_support $rows`, {
      rows: batch.map((r) => ({
        ...r,
        in: new StringRecordId(r.in),
        out: new StringRecordId(r.out),
      })),
    });
  }
}

/**
 * Recompose form: derivedFrom was REWRITTEN, so the stale mirror goes
 * first — two-step LET-select-ids → DELETE $ids, MANDATORY on 3.2.4:
 * `in` is covered by the COMPOUND support_edge_uq index, and a
 * `DELETE memory_support WHERE in = …` is the reproduced silent
 * planner no-op (see the 0116 header) — then the new set is inserted.
 */
export async function replaceDerivedFromEdges(
  db: DbLike,
  mirror: DerivedFromMirror,
): Promise<void> {
  await db.query(
    `LET $edgeIds = (SELECT VALUE id FROM memory_support
       WHERE in = $summary AND kind = 'derived_from');
     DELETE $edgeIds;`,
    { summary: new StringRecordId(mirror.summaryId) },
  );
  await insertDerivedFromEdges(db, mirror);
}
