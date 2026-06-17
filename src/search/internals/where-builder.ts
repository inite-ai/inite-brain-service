import { StringRecordId } from 'surrealdb';
import type { SearchDto } from '../dto/search.dto';

/**
 * Compose the WHERE-clause fragment that every leg query shares.
 * Returns SQL parts only — caller splices them into the leg's own
 * SELECT. Keeps bitemporal closure / scope filters / predicate filters
 * in one place so leg queries don't drift.
 *
 * Pure function — no DB, no embedder, no policy lookup. All inputs
 * flow in via the dto + flags; outputs are SQL + bound params.
 */
export function buildBaseWhere(
  dto: SearchDto,
  asOf: Date | null,
  includeRetracted: boolean,
  includeContested: boolean,
): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (!includeRetracted) clauses.push(`AND retractedAt IS NONE`);
  if (!includeContested) clauses.push(`AND status != 'competing'`);
  if (dto.minConfidence !== undefined) {
    clauses.push(`AND confidence >= $minConfidence`);
    params.minConfidence = dto.minConfidence;
  }
  if (dto.predicates && dto.predicates.length > 0) {
    clauses.push(`AND predicate INSIDE $predicates`);
    params.predicates = dto.predicates;
  }
  if (dto.entityIds && dto.entityIds.length > 0) {
    // Multi-hop anchoring. Accept both short and fully-qualified ids;
    // SurrealDB record-link parsing tolerates both via the
    // `type::thing` cast at query time.
    clauses.push(`AND entityId INSIDE $entityIds`);
    params.entityIds = dto.entityIds.map((raw) => {
      const id = raw.startsWith('knowledge_entity:')
        ? raw.slice('knowledge_entity:'.length)
        : raw;
      return new StringRecordId(`knowledge_entity:${id}`);
    });
  }

  // ── Bitemporal "actual now" default ────────────────────────────
  // Datomic / Graphiti / Zep convention. When the caller provides
  // no `asOf` and doesn't opt into stale, default search returns
  // only facts whose validity interval contains query-time AND
  // that haven't been superseded / compacted out. Reasoning:
  //
  //   95% of memory-layer callers want "what's true RIGHT NOW".
  //   Bitemporal access ("what was true on date X") is the
  //   exception, served by the `asOf` parameter or the entity
  //   timeline endpoint.
  if (asOf) {
    // Explicit historical asOf — point-in-time view.
    // Filter on the VALIDITY axis (validFrom/validUntil); do NOT
    // gate on recordedAt — search shouldn't disappear a fact just
    // because brain learned it after the asOf cutoff (e.g. a
    // January tier change reported in May).
    clauses.push(
      `AND (retractedAt IS NONE OR retractedAt > $asOf)
         AND validFrom <= $asOf
         AND (validUntil IS NONE OR validUntil > $asOf)
         AND status != 'compacted'`,
    );
    params.asOf = asOf;
  } else if (!dto.includeStale) {
    // Default "actual now" — current truth.
    clauses.push(
      `AND validFrom <= time::now()
         AND (validUntil IS NONE OR validUntil > time::now())
         AND status NOT IN ['superseded', 'compacted']`,
    );
  }
  // else: includeStale=true and no asOf → audit shape, no temporal
  // closure beyond the retractedAt / competing gates above.

  return { sql: clauses.join('\n        '), params };
}
