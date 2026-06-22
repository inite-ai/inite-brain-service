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
export interface BaseWhereOptions {
  /**
   * Phase 4.B locale-aware retrieval. When supplied (and not
   * disabled via the dto), the WHERE clause restricts to facts
   * whose `lang` is either the supplied code or NONE (pre-Phase-4
   * facts that haven't been backfilled — keeping them visible
   * avoids regressing recall while the corpus catches up).
   */
  langFilter?: string;
}

export function buildBaseWhere(
  dto: SearchDto,
  asOf: Date | null,
  includeRetracted: boolean,
  includeContested: boolean,
  opts: BaseWhereOptions = {},
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
  if (opts.langFilter && !dto.disableLangFilter) {
    // Pre-Phase-4 facts have lang IS NONE — keep them visible so
    // back-filling the corpus is a soft migration, not a recall
    // cliff. Recall-critical callers can disable via
    // `disableLangFilter: true`.
    clauses.push(`AND (lang = $langFilter OR lang IS NONE)`);
    params.langFilter = opts.langFilter;
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
    //
    // Future-dated supersede gap: when a single_active fact B is ingested
    // with validFrom in the future, fn::resolve_fact closes the prior A at
    // A.validUntil = B.validFrom (future) and marks A 'superseded'. Between
    // now and B.validFrom, A is still the value that holds — its interval
    // [validFrom, validUntil) contains now — yet a blanket
    // `status NOT IN ['superseded']` hid it AND B isn't visible yet
    // (validFrom > now), leaving "no current value". So admit a superseded
    // fact whose interval still covers now: the `validUntil > now` guard
    // (already required above) means a normally-closed supersede, where
    // validUntil <= now, stays hidden; only the future-gap prior survives.
    clauses.push(
      `AND validFrom <= time::now()
         AND (validUntil IS NONE OR validUntil > time::now())
         AND status != 'compacted'
         AND (status != 'superseded' OR validUntil > time::now())`,
    );
  }
  // else: includeStale=true and no asOf → audit shape, no temporal
  // closure beyond the retractedAt / competing gates above.

  return { sql: clauses.join('\n        '), params };
}
