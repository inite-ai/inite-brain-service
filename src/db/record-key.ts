/**
 * The key part of a record id string, ready to bind into the two-argument
 * `type::record('table', $key)`.
 *
 * Why not compose `type::record('table:' + $x)` or `type::record($full)`:
 * the single-argument form PARSES its string as a record id. A key with
 * `-` or `:` in it parsed differently across SurrealDB generations (3.x
 * truncated at the minus; 4.0 rejects it), so a composed id could address
 * a different row or fail the whole statement. The two-argument form takes
 * the key as a value and never parses it.
 *
 * Input is either a bare key or a full id as brain renders it
 * (`table:key`, see record-id-format.ts). A rendered key that needed
 * delimiting arrives as `⟨…⟩` or `` `…` ``; the delimiters are syntax, not
 * part of the key, so they are removed. A bare all-digit key is an integer
 * key — the parser reads `t:42` as the number 42, and a string key of
 * digits is always rendered delimited — so it is returned as a number to
 * address the same row the single-argument form did.
 */

import { RecordId } from 'surrealdb';

const TABLE_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*:/;
const DIGITS = /^\d+$/;

function unwrap(tail: string, open: string, close: string): string | null {
  if (tail.length < 2 || !tail.startsWith(open) || !tail.endsWith(close)) return null;
  return tail.slice(open.length, tail.length - close.length).replace(/\\(.)/gu, '$1');
}

/** The key of `id` (`table:key`, `table:⟨key⟩`, or a bare key). */
export function recordKey(id: string): string | number {
  const prefix = TABLE_PREFIX.exec(id);
  const tail = prefix ? id.slice(prefix[0].length) : id;
  const delimited = unwrap(tail, '⟨', '⟩') ?? unwrap(tail, '`', '`');
  if (delimited !== null) return delimited;
  if (DIGITS.test(tail)) {
    const n = Number(tail);
    if (Number.isSafeInteger(n)) return n;
  }
  return tail;
}

/**
 * A bound record id for `table` from a full id or a bare key — the
 * parameter-side twin of `type::record('table', $key)`. Unlike
 * a composed `StringRecordId('table:' + key)`, nothing is parsed server-side.
 */
export function recordIdOf(table: string, id: string): RecordId {
  return new RecordId(table, recordKey(id));
}
