import { Surreal, StringRecordId } from 'surrealdb';
import type { SearchDto } from '../dto/search.dto';
import type { FactRow } from './types';

/**
 * Backfill: for each top-K entity, fetch its top-N predicate-diverse
 * active facts via a SurrealDB inline subquery — one query, one round
 * trip, transactional snapshot. Solves the "router routes the right
 * class but the fact never reached the candidate set" miss mode the
 * per-predicate eval surfaced for dob queries on few-thousand-fact
 * tenants.
 *
 * The subquery inherits the scoped DB connection, so DB-level PII
 * PERMISSIONS strip gated fields for non-PII callers automatically. We
 * still apply `passesPolicy` on the JS side because the row +
 * predicate still surface (only `object` is null'd by PERMISSIONS) and
 * the mustNotLeakPredicate check on the eval-side reads predicate.
 *
 * Per-entity LIMIT pushed into DB — no JS-side dedup needed, no
 * over-fetch.
 */
export async function backfillEntityFacts(
  db: Surreal,
  logger: { warn: (msg: string) => void },
  entityIds: string[],
  baseWhere: { sql: string; params: Record<string, unknown> },
  dto: SearchDto,
  callerScopes: string[],
  passesPolicy: (row: FactRow, dto: SearchDto, scopes: string[]) => boolean,
): Promise<Map<string, FactRow[]>> {
  const out = new Map<string, FactRow[]>();
  if (entityIds.length === 0) return out;
  const ids = entityIds.map((raw) => {
    const id = raw.startsWith('knowledge_fact:')
      ? raw // defensive — fact ids should not appear here
      : raw.startsWith('knowledge_entity:')
        ? raw.slice('knowledge_entity:'.length)
        : raw;
    return new StringRecordId(`knowledge_entity:${id}`);
  });
  // Inline subquery references $parent.id (the outer entity row).
  // baseWhere.sql comes pre-formatted with leading "AND <clauses>" —
  // splice it directly into the subquery WHERE so bitemporal cutoff,
  // status filters, and predicate filters compose naturally.
  const sql = `
      SELECT
        id,
        (
          SELECT
            id, entityId, predicate, object, confidence,
            validFrom, validUntil, recordedAt, retractedAt, status, source
          FROM knowledge_fact
          WHERE entityId = $parent.id
            ${baseWhere.sql}
          ORDER BY recordedAt DESC
          LIMIT 50
        ) AS facts
      FROM knowledge_entity WHERE id INSIDE $entityIds
    `;
  try {
    const [rows] = await db.query<
      [Array<{ id: unknown; facts: FactRow[] }>]
    >(sql, {
      ...baseWhere.params,
      entityIds: ids,
    });
    for (const r of (rows as Array<{ id: unknown; facts: FactRow[] }>) ?? []) {
      const key = String(r.id);
      const facts: FactRow[] = [];
      for (const row of r.facts ?? []) {
        if (!passesPolicy(row, dto, callerScopes)) continue;
        facts.push(row);
      }
      out.set(key, facts);
    }
  } catch (err) {
    // Backfill is best-effort — a failed query degrades to "matched
    // facts only", the pre-backfill behaviour. Log and continue.
    logger.warn(`Entity-fact backfill fell back to empty: ${(err as Error).message}`);
  }
  return out;
}
