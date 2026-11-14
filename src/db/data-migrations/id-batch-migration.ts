import type { Surreal } from 'surrealdb';
import { queryRows } from '../surreal.service';
import type { DataMigration } from './data-migration';

/**
 * The safe shape of a row fix: ids first, then an UPDATE of exactly those
 * record ids.
 *
 *   LET $ids = (SELECT VALUE id FROM t WHERE <cond> LIMIT $n);
 *   UPDATE $ids SET <set> WHERE <cond> RETURN VALUE id;
 *
 * Updating explicit record ids never iterates the table, so it never takes
 * the index-planned path on which 3.2.4 turns `UPDATE t … WHERE` into a
 * silent no-op. The WHERE on the second statement is re-checked per row, so
 * a writer that fixed or changed a row between the two statements is left
 * alone. Both statements run in one request; the result index of the
 * UPDATE is 1 (`[, rows]`).
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
      `SELECT count() AS c FROM ${this.table} WHERE ${this.where} GROUP ALL`,
    );
    return Number(rows[0]?.c ?? 0);
  }

  async step(db: Surreal, limit: number): Promise<number> {
    const [, fixed] = await db.query<[unknown, unknown[]]>(
      `LET $ids = (SELECT VALUE id FROM ${this.table} WHERE ${this.where} LIMIT $n);
       UPDATE $ids SET ${this.set} WHERE ${this.where} RETURN VALUE id;`,
      { n: Math.max(1, Math.floor(limit)) },
    );
    return (fixed ?? []).length;
  }
}
