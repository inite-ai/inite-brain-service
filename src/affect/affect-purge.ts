import { StringRecordId } from 'surrealdb';

/** The query handle the purge runs on (a tenant connection). */
export interface PurgeHandle {
  query<T extends unknown[]>(sql: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * Erase a set of facts and beliefs and everything that keeps their words —
 * the user-forget cascade (src/entities/user-forget.service.ts) narrowed to
 * explicit ids, for erasing ONE category of a person's memory (#909: "erase
 * my emotional data") rather than all of it.
 *
 * Order follows forget: side tables that traverse into the rows go first,
 * then rows composed FROM them (an arc or summary that `derivedFrom` an
 * erased fact quotes it), then the rows, then the audit mirror. Every step
 * is LET-select-ids → DELETE by ids: on SurrealDB 3.2.4 a DELETE whose WHERE
 * traverses an indexed record field silently matches nothing (the planner
 * trap the forget cascade documents step by step).
 */
export async function purgeAffectRows(
  db: PurgeHandle,
  ids: { factIds: string[]; beliefIds: string[] },
): Promise<{ factsDeleted: number; beliefsDeleted: number; derivedDeleted: number }> {
  const facts = ids.factIds.map((id) => new StringRecordId(id));
  const beliefs = ids.beliefIds.map((id) => new StringRecordId(id));
  if (facts.length === 0 && beliefs.length === 0) {
    return { factsDeleted: 0, beliefsDeleted: 0, derivedDeleted: 0 };
  }
  // Rows composed from the erased facts carry their words.
  const [derived] = await db.query<[unknown[]]>(
    `SELECT VALUE id FROM knowledge_fact WHERE derivedFrom CONTAINSANY $facts`,
    { facts },
  );
  const derivedIds = (derived ?? []).map((id) => new StringRecordId(String(id)));
  const allFacts = [...facts, ...derivedIds];
  const factStrings = allFacts.map(String);
  const subjects = [...allFacts, ...beliefs];

  await db.query(
    `LET $usage = (SELECT VALUE id FROM fact_usage WHERE factId INSIDE $facts);
     DELETE $usage;
     LET $feedback = (SELECT VALUE id FROM retrieval_feedback WHERE factId INSIDE $facts);
     DELETE $feedback;
     LET $outcomes = (SELECT VALUE id FROM memory_outcome WHERE subjectId INSIDE $facts);
     DELETE $outcomes;
     LET $outcomeStats = (SELECT VALUE id FROM memory_outcome_stat WHERE subjectId INSIDE $facts);
     DELETE $outcomeStats;
     LET $support = (SELECT VALUE id FROM memory_support
       WHERE in INSIDE $subjects OR out INSIDE $subjects);
     DELETE $support;
     LET $answers = (SELECT VALUE id FROM answer_cache WHERE citedFactIds CONTAINSANY $factStrings);
     DELETE $answers;`,
    { facts: allFacts, subjects, factStrings },
  );
  // Compiled dossiers of the entities the facts sat on recompile without them.
  const [entities] = await db.query<[unknown[]]>(
    `SELECT VALUE entityId FROM knowledge_fact WHERE id INSIDE $facts`,
    { facts: allFacts },
  );
  const entityIds = [...new Set((entities ?? []).map(String))].map((e) => new StringRecordId(e));
  if (entityIds.length > 0) {
    await db.query(
      `LET $artifacts = (SELECT VALUE id FROM knowledge_artifact WHERE entityId INSIDE $ents);
       DELETE $artifacts;`,
      { ents: entityIds },
    );
  }
  if (allFacts.length > 0) await db.query(`DELETE $ids`, { ids: allFacts });
  if (beliefs.length > 0) await db.query(`DELETE $ids`, { ids: beliefs });
  const mirrored = [...factStrings, ...beliefs.map(String)];
  if (mirrored.length > 0) {
    await db.query(`DELETE audit_event WHERE recordId IN $ids`, { ids: mirrored });
  }
  return {
    factsDeleted: facts.length,
    beliefsDeleted: beliefs.length,
    derivedDeleted: derivedIds.length,
  };
}
