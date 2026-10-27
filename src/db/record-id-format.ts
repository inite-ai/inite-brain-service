/**
 * The public string form of a record id: `table:id`, exactly as brain has
 * written it since its first release.
 *
 * surrealdb 2.0.9+ renders a record id whose id part starts with a digit,
 * or is a SurrealQL keyword, delimited — `knowledge_fact:⟨4m8g…⟩` — which is
 * the right thing for a query text and the wrong thing for an identity
 * string. `RecordId.toString` is also what `toJSON` returns, so the change
 * would rewrite every factId, entityId and episodeId in REST and MCP
 * answers (clients store them), and every id string brain itself stored
 * (commitRef, sharedFrom, provenance pointers) would stop matching the ids
 * it renders afresh. Random ids start with a digit about one time in three.
 *
 * Installed once, on import: the id part is rendered by the 2.0.8 rule (a
 * plain `[A-Za-z0-9_]` id that is not all digits stays bare; anything else
 * is delimited as the driver delimits it), the table part likewise. Queries
 * are unaffected: brain passes record ids to SurrealDB as bound values
 * (CBOR), never as text.
 */
import { RecordId } from 'surrealdb';

const PLAIN = /^[A-Za-z0-9_]+$/;
const ONLY_NUMBERS = /^[\d_]+$/;

/** Whether the 2.0.8 driver left this ident bare. */
export function isBareIdent(s: string): boolean {
  return s !== '' && PLAIN.test(s) && !ONLY_NUMBERS.test(s);
}

const INSTALLED = Symbol.for('inite.brain.recordIdFormat');

type Patchable = { toString(): string; [INSTALLED]?: true };

export function installRecordIdFormat(): void {
  const proto = RecordId.prototype as unknown as Patchable;
  if (proto[INSTALLED]) return;
  const driverToString = proto.toString;
  proto.toString = function (this: RecordId): string {
    const table = this.table.name;
    const id: unknown = this.id;
    if (typeof id === 'string' && isBareIdent(id) && isBareIdent(table)) return `${table}:${id}`;
    return driverToString.call(this);
  };
  proto[INSTALLED] = true;
}

installRecordIdFormat();
