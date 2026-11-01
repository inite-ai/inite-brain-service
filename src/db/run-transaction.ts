import type { Surreal } from 'surrealdb';
import { enrichTransactionError } from './surreal-retry';

/**
 * Run a SurrealDB transaction. The WebSocket protocol's `query()` method
 * scopes each call as its own evaluation context, so BEGIN/COMMIT issued
 * via separate `query()` calls fail with `Unexpected statement type
 * encountered: Commit(CommitStatement)` — the COMMIT statement has no
 * matching BEGIN in scope. The fix is to send the entire transaction as
 * one multi-statement SurrealQL block in a single `query()` call.
 *
 * `runTransaction` lets the caller assemble statements via a builder and
 * sends them all together inside `BEGIN TRANSACTION; ...; COMMIT
 * TRANSACTION;`. The return value is the result of the LAST statement,
 * which the caller can shape with a final `RETURN $...` line.
 *
 * Use for: CREATE entity + CREATE external_ref (must both succeed),
 * CREATE fact + cascade-MERGE on competing facts (partial state is bad).
 */
export interface TxBuilder {
  /** Append a statement to the transaction. Returns the builder for chaining. */
  add(sql: string): TxBuilder;
  /** Bind a parameter; the same `vars` map is shared across all statements. */
  bind(name: string, value: unknown): TxBuilder;
}

export async function runTransaction<T>(db: Surreal, build: (tx: TxBuilder) => void): Promise<T> {
  const stmts: string[] = [];
  const vars: Record<string, unknown> = {};
  const builder: TxBuilder = {
    add(sql) {
      stmts.push(sql.trim().replace(/;\s*$/, ''));
      return builder;
    },
    bind(name, value) {
      vars[name] = value;
      return builder;
    },
  };
  build(builder);

  // Compose: BEGIN; <stmt>; <stmt>; ...; COMMIT;
  const sql =
    ['BEGIN TRANSACTION', ...stmts, 'COMMIT TRANSACTION']
      .map((s) => s.replace(/;\s*$/, ''))
      .join(';\n') + ';';

  // Aborted BEGIN/COMMIT batches surface as a bare "failed transaction"
  // wrapper that hides the retriable per-statement cause; enrich it so the
  // surrounding retry loop can classify it (see enrichTransactionError).
  // Non-wrapper errors pass through unchanged.
  let result: unknown[];
  try {
    result = await db.query<unknown[]>(sql, vars);
  } catch (err) {
    throw enrichTransactionError(err);
  }
  const arr = result as unknown[];
  // The caller's last statement is the RETURN it wants, but WHERE that
  // lands in the response depends on the server generation (verified
  // empirically against v2.3.10 and v3.1.5):
  //
  //   3.x — one slot per top-level statement INCLUDING `BEGIN` and the
  //   trailing `COMMIT` (both null): N user statements → N+2 slots, the
  //   RETURN sits at length-2. Taking length-1 here reads the COMMIT
  //   null and silently turns every transactional upsert into
  //   `undefined` (historically: spurious self-merge 400s).
  //
  //   2.x — BEGIN/COMMIT emit no slots (and LETs may be collapsed too):
  //   always ≤ N slots, the RETURN is simply the LAST one. Taking
  //   length-2 there reads the statement BEFORE the RETURN — on prod
  //   v2.3.10 this made every lease acquire and job claim silently
  //   discard its committed result (gauge stuck at 0, queue never
  //   dispatched) with zero errors logged.
  //
  // We compose exactly one BEGIN and one COMMIT, so the shapes are
  // disjoint: only a 3.x server can answer with stmts+2 slots.
  return (arr.length === stmts.length + 2 ? arr[arr.length - 2] : arr[arr.length - 1]) as T;
}
