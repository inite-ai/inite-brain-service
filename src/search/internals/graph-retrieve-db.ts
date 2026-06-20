import { Surreal, StringRecordId } from 'surrealdb';
import type { GraphEntity, GraphFactRow } from './graph-retrieve';

/**
 * DB layer for graph-retrieve. Three queries:
 *   1. Resolve seed entities by canonicalNameLc OR substring scan.
 *   2. Fetch 1-hop neighbour ids over knowledge_edge (both directions).
 *   3. Fetch facts for (seeds ∪ neighbours) under the bitemporal closure
 *      and an optional predicate-hint filter.
 *
 * Each query soft-fails (logs + returns empty) so a partial DB outage
 * degrades the demo path to "graph found nothing" rather than 500.
 */

/**
 * Resolve seed entities. Two passes:
 *   (a) explicit names from entityRefs → canonicalNameLc IN $refs.
 *   (b) substring fallback: scan top-N entities, keep those whose
 *       canonicalNameLc is contained in the lowered query text.
 *
 * Pass (a) wins when it returns anything; (b) is the safety net for
 * messages where the chat-router didn't lift a clean mention.
 */
export async function resolveSeedEntities(
  db: Surreal,
  queryText: string,
  entityRefs: string[],
): Promise<GraphEntity[]> {
  const targetLc = queryText.trim().toLowerCase();
  if (entityRefs.length > 0) {
    const refsLc = entityRefs.map((n) => n.toLowerCase());
    const [rows] = await db.query<
      [
        Array<{
          id: unknown;
          type: string;
          canonicalName: string;
          externalRefs?: Record<string, string>;
        }>,
      ]
    >(
      `SELECT id, type, canonicalName, externalRefs
         FROM knowledge_entity
        WHERE mergedInto IS NONE
          AND canonicalNameLc IN $refs
        LIMIT 10`,
      { refs: refsLc },
    );
    const seeds = (rows ?? []).map(toGraphEntity);
    if (seeds.length > 0) return seeds;
  }
  if (!targetLc) return [];
  // BM25 SEARCH fallback. Pre-fix this branch did a `SELECT … LIMIT
  // 200` full-table scan and a JS-side substring filter — linear in
  // tenant entity count per ask, hot-path. We have `entity_name_search_idx`
  // (BM25 SEARCH ANALYZER content, migration 0002) defined for exactly
  // this purpose. Route through it and let SurrealDB score + rank;
  // returned `score` lets us prefer better matches without the
  // length-sort heuristic.
  //
  // Notes on the syntax:
  //   - `canonicalName @1@ $q` means "matcher 1 against the BM25 index"
  //   - `search::score(1)` reads the score for that matcher
  //   - We keep `mergedInto IS NONE` so identity-merged entities don't
  //     resurface.
  const [allRows] = await db.query<
    [
      Array<{
        id: unknown;
        type: string;
        canonicalName: string;
        externalRefs?: Record<string, string>;
        bm25?: number;
      }>,
    ]
  >(
    `SELECT id, type, canonicalName, externalRefs,
            search::score(1) AS bm25
       FROM knowledge_entity
      WHERE mergedInto IS NONE
        AND canonicalName @1@ $q
      ORDER BY bm25 DESC
      LIMIT 5`,
    { q: targetLc },
  );
  return (allRows ?? []).map(toGraphEntity);
}

/**
 * Fetch 1-hop neighbour entity ids over knowledge_edge. Direction-
 * agnostic — both ->edge-> and <-edge<- contribute, so Acme→Maria
 * (works_at outbound) and Maria←Acme (mentioned_with inbound) both
 * surface. Self-loops are dropped (identity_of after merge).
 *
 * Returns FULL entity ids (with the table prefix `knowledge_entity:`)
 * so they round-trip through the next query's WHERE INSIDE clause.
 */
export async function fetchOneHopNeighbourIds(
  db: Surreal,
  seedIds: string[],
): Promise<string[]> {
  if (seedIds.length === 0) return [];
  const rids = seedIds.map((s) => new StringRecordId(s));
  type Row = {
    id: unknown;
    outNeighbours: Array<{ peer: { id: unknown } | null }> | null;
    inNeighbours: Array<{ peer: { id: unknown } | null }> | null;
  };
  const [rows] = await db.query<[Row[]]>(
    `SELECT
        id,
        ->knowledge_edge.{ peer: out.{id} } AS outNeighbours,
        <-knowledge_edge.{ peer: in.{id} } AS inNeighbours
      FROM $ids`,
    { ids: rids },
  );
  const out = new Set<string>();
  for (const row of rows ?? []) {
    const seedId = String(row.id);
    const consider = (
      side: Array<{ peer: { id: unknown } | null }> | null,
    ) => {
      if (!side) return;
      for (const e of side) {
        if (!e?.peer) continue;
        const peerId = String(e.peer.id);
        if (peerId === seedId) continue;
        out.add(peerId);
      }
    };
    consider(row.outNeighbours);
    consider(row.inNeighbours);
  }
  return [...out];
}

/**
 * Fetch entity records for a list of ids. Used to hydrate neighbour
 * data once we know which ids the seed-walk surfaced.
 */
export async function fetchEntitiesByIds(
  db: Surreal,
  ids: string[],
): Promise<GraphEntity[]> {
  if (ids.length === 0) return [];
  const rids = ids.map((s) => new StringRecordId(s));
  const [rows] = await db.query<
    [
      Array<{
        id: unknown;
        type: string;
        canonicalName: string;
        externalRefs?: Record<string, string>;
      }>,
    ]
  >(
    `SELECT id, type, canonicalName, externalRefs
       FROM knowledge_entity
      WHERE id INSIDE $ids
        AND mergedInto IS NONE`,
    { ids: rids },
  );
  return (rows ?? []).map(toGraphEntity);
}

/**
 * Fetch facts for a set of entity ids, grouped by entityId. Applies
 * the bitemporal-now closure (or the explicit asOf cut), the standard
 * status gate, and an OPTIONAL predicate-hint filter.
 *
 * Per-entity LIMIT 16: enough headroom for dedup-by-(predicate,object)
 * to still surface a couple of distinct facts on busy entities, small
 * enough that the demo response stays tight.
 */
export async function fetchFactsForEntities(
  db: Surreal,
  entityIds: string[],
  predicateHints: string[],
  asOf: string | undefined,
): Promise<Map<string, GraphFactRow[]>> {
  const out = new Map<string, GraphFactRow[]>();
  if (entityIds.length === 0) return out;
  const rids = entityIds.map((s) => new StringRecordId(s));
  const hasHints = predicateHints.length > 0;
  const predicateClause = hasHints ? ' AND predicate INSIDE $hints' : '';
  const where = asOf
    ? `entityId INSIDE $ids
       AND (retractedAt IS NONE OR retractedAt > $asOf)
       AND validFrom <= $asOf
       AND (validUntil IS NONE OR validUntil > $asOf)
       AND status != 'compacted'`
    : `entityId INSIDE $ids
       AND retractedAt IS NONE
       AND validFrom <= time::now()
       AND (validUntil IS NONE OR validUntil > time::now())
       AND status != 'compacted'`;
  const params: Record<string, unknown> = {
    ids: rids,
    ...(asOf ? { asOf: new Date(asOf) } : {}),
    ...(hasHints ? { hints: predicateHints } : {}),
  };
  type FactSelect = {
    id: unknown;
    entityId: unknown;
    predicate: string;
    object: string;
    confidence: number;
    validFrom: string;
    validUntil?: string;
    status: string;
    recordedAt: string;
  };
  const [rows] = await db.query<[FactSelect[]]>(
    `SELECT id, entityId, predicate, object, confidence,
            validFrom, validUntil, status, recordedAt
       FROM knowledge_fact
      WHERE ${where}${predicateClause}
      ORDER BY recordedAt DESC
      LIMIT 200`,
    params,
  );
  for (const r of rows ?? []) {
    const eid = String(r.entityId);
    const list = out.get(eid) ?? [];
    if (list.length >= 16) continue;
    list.push({
      factId: String(r.id),
      entityId: eid,
      predicate: r.predicate,
      object: r.object,
      confidence: r.confidence,
      validFrom: r.validFrom,
      ...(r.validUntil ? { validUntil: r.validUntil } : {}),
      status: r.status,
      recordedAt: r.recordedAt,
    });
    out.set(eid, list);
  }
  return out;
}

function toGraphEntity(row: {
  id: unknown;
  type: string;
  canonicalName: string;
  externalRefs?: Record<string, string>;
}): GraphEntity {
  return {
    entityId: String(row.id),
    type: row.type,
    canonicalName: row.canonicalName,
    externalRefs: row.externalRefs,
  };
}
