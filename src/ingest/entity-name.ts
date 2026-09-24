/**
 * An entity's name follows its `name` fact.
 *
 * A reference-minted entity is born named by its reference id — a
 * customer from a CRM by `cust_42`, the user's own entity
 * (user-entity.ts) by their userId. Its name is MEMORY, not
 * configuration: the current `name` fact on it, written by the user's
 * own words ("Я Саша", "this is Mike" — the extractor files those under
 * the core predicate `name`) or by a client at onboarding (a typed fact
 * on the user's reference). The canonical name follows that fact; the
 * old name stays an alias so lookups by the reference id keep working.
 * A credential's claims never name anyone: the token says who the
 * subject is, the memory learns what they are called.
 *
 * The rule is narrow on purpose: an entity minted from a NAME (the
 * extractor's "Rui Almeida") keeps it — a later `name: Rui` fact is a
 * short form, not a rename. Only two kinds of entity follow the fact:
 * one still named by its reference id, and the user's own entity, whose
 * identity is whatever they last said it is. Both conditions are read
 * off the row itself in the one UPDATE, so nothing is fetched first.
 *
 * And the fact's scope must be the entity's: identity is tenant-wide
 * while a fact may be personal (0055), so a user's private `name` fact
 * on a shared node stays theirs — the node's visible name never comes
 * from one user's private words. The user's own node is personal and
 * follows their personal fact; a tenant-global name fact names a
 * tenant-global node.
 *
 * Pure SQL helper — one statement, called from the fact resolver's
 * post-write tail on the outcomes that make the fact the current one.
 */
import type { Surreal } from 'surrealdb';
import { StringRecordId } from 'surrealdb';
import { nameKeysFor } from '../common/name-key';
import { userEntityKey } from './user-entity';

/** The core predicate the extractor and the onboarding write file names under. */
export const NAME_PREDICATE = 'name';

/** The outcomes after which the fact IS the entity's current name. */
const CURRENT_OUTCOMES: ReadonlySet<string> = new Set(['INSERTED', 'SUPERSEDED']);

export async function followNameFact(
  db: Surreal,
  p: {
    entityId: string;
    predicate: string;
    predicateAlias?: string | undefined;
    object: string;
    userId?: string | undefined;
    outcome: string | undefined;
  },
): Promise<boolean> {
  if ((p.predicateAlias ?? p.predicate) !== NAME_PREDICATE) return false;
  if (!p.outcome || !CURRENT_OUTCOMES.has(p.outcome)) return false;
  const name = p.object.trim();
  if (!name) return false;
  // SET evaluates left to right: the union sees the old canonical name.
  const rows = await db.query<[Array<{ id: unknown }>]>(
    `UPDATE $id SET
        aliases = array::union(aliases ?? [], [canonicalName, $name]),
        nameKeys = array::distinct(array::concat(nameKeys ?? [], $keys)),
        canonicalName = $name
      WHERE canonicalName != $name
        AND (canonicalName IN object::values(externalRefs ?? {})
             OR $userKey IN object::keys(externalRefs ?? {}))
        AND (IF $factUser IS NONE THEN userId IS NONE ELSE userId = $factUser END)
      RETURN id`,
    {
      id: new StringRecordId(p.entityId),
      name,
      keys: nameKeysFor([name]),
      userKey: p.userId ? userEntityKey(p.userId) : '',
      factUser: p.userId,
    },
  );
  return (rows?.[0]?.length ?? 0) > 0;
}
