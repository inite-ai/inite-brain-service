import type { Surreal } from 'surrealdb';
import { queryRows } from '../surreal.service';
import type { DataMigration } from './data-migration';

/**
 * The safe shape of a row fix: ids first, then an UPDATE of exactly those
 * record ids.
 *
 *   LET $ids = (SELECT VALUE id FROM t WITH NOINDEX WHERE <cond> LIMIT $n);
 *   UPDATE $ids SET <set> WHERE <cond> RETURN VALUE id;
 *
 * Updating explicit record ids never iterates the table, so it never takes
 * the index-planned path on which 3.2.4 turns `UPDATE t … WHERE` into a
 * silent no-op. The WHERE on the second statement is re-checked per row, so
 * a writer that fixed or changed a row between the two statements is left
 * alone. Both statements run in one request; the result index of the
 * UPDATE is 1 (`[, rows]`).
 *
 * The count and the id selection read the table WITH NOINDEX. An index
 * defined earlier in the same transaction as a backfill stays stale on
 * 3.2.4 (the build sees committed state only): on production, 0182's index
 * still listed 16 edges as unmarked that the rows themselves had marked,
 * so an indexed `pending` never reached 0 and the step "fixed none". A
 * data migration exists to repair exactly such histories, so it must
 * judge the rows, not an index over them. The tables are walked once per
 * batch; data migrations run in the background with a time budget.
 *
 * `table`, `where` and `set` are constants of the subclass, never input.
 */
export abstract class IdBatchMigration implements DataMigration {
  abstract readonly id: string;
  abstract readonly description: string;
  protected abstract readonly table: string;
  /** The rows that still need the fix. Also the definition of `pending`. */
  protected abstract readonly where: string;
  /** The fix, as a SET list over the row's own fields. */
  protected abstract readonly set: string;

  async pending(db: Surreal): Promise<number> {
    const rows = await queryRows<{ c: number }>(
      db,
      `SELECT count() AS c FROM ${this.table} WITH NOINDEX WHERE ${this.where} GROUP ALL`,
    );
    return Number(rows[0]?.c ?? 0);
  }

  async step(db: Surreal, limit: number): Promise<number> {
    const [, fixed] = await db.query<[unknown, unknown[]]>(
      `LET $ids = (SELECT VALUE id FROM ${this.table} WITH NOINDEX WHERE ${this.where} LIMIT $n);
       UPDATE $ids SET ${this.set} WHERE ${this.where} RETURN VALUE id;`,
      { n: Math.max(1, Math.floor(limit)) },
    );
    return (fixed ?? []).length;
  }
}
