import { Surreal, StringRecordId } from 'surrealdb';

export type Neighbour = {
  canonicalName: string;
  type: string;
  kind: string;
};

/**
 * Fetch 1-hop neighbours for a set of entity ids in a single batched
 * query. Returns a map keyed by entity id (string) to the list of
 * `(canonicalName, type, kind)` triples — both outgoing and incoming
 * edges, deduped on the (peer, kind) pair.
 *
 * Used to inject SubgraphRAG-style structural context into the
 * reranker prompt. Bounded by the candidate-set size (≤ rerank
 * window, currently 20), so the query is small and runs in a few ms
 * even on dense tenants. Returns an empty map on any failure — the
 * reranker falls back to its non-graph path.
 */
export async function fetchNeighbours(
  db: Surreal,
  logger: { warn: (msg: string) => void },
  entityIds: string[],
): Promise<Map<string, Neighbour[]>> {
  const out = new Map<string, Neighbour[]>();
  if (entityIds.length === 0) return out;
  const rids = entityIds.map((s) => new StringRecordId(s));
  type Row = {
    id: unknown;
    outNeighbours: Array<{
      kind: string;
      peer: { id: unknown; type: string; canonicalName: string } | null;
    }> | null;
    inNeighbours: Array<{
      kind: string;
      peer: { id: unknown; type: string; canonicalName: string } | null;
    }> | null;
  };
  try {
    const [rows] = await db.query<[Row[]]>(
      `SELECT
           id,
           ->knowledge_edge.{ kind, peer: out.{id, type, canonicalName} } AS outNeighbours,
           <-knowledge_edge.{ kind, peer: in.{id, type, canonicalName} } AS inNeighbours
         FROM $ids`,
      { ids: rids },
    );
    for (const row of (rows as Row[]) ?? []) {
      const id = String(row.id);
      const list: Neighbour[] = [];
      const seen = new Set<string>();
      const pushSide = (
        side: Array<{
          kind: string;
          peer: { id: unknown; type: string; canonicalName: string } | null;
        }> | null,
      ) => {
        if (!side) return;
        for (const e of side) {
          if (!e?.peer) continue;
          const peerId = String(e.peer.id);
          // Self-loop guard (identity_of after merge): skip when
          // the peer is the entity itself.
          if (peerId === id) continue;
          const key = `${peerId}|${e.kind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          list.push({
            canonicalName: e.peer.canonicalName,
            type: e.peer.type,
            kind: e.kind,
          });
        }
      };
      pushSide(row.outNeighbours);
      pushSide(row.inNeighbours);
      out.set(id, list);
    }
  } catch (err) {
    logger.warn(
      `fetchNeighbours failed, reranker falls back without graph context: ${(err as Error).message}`,
    );
  }
  return out;
}

/**
 * Expand a list of entity ids by their 1-hop neighbourhood over
 * knowledge_edge. Used by MultiHopService for graph-aware
 * `subset_of_previous` chaining — "tenants who complained AND their
 * direct neighbours (project, household, building)" rather than
 * exact set membership.
 *
 * Returns a de-duplicated id list = original ∪ 1-hop neighbours,
 * preserving original ids first so downstream `entityIds INSIDE`
 * matches stay deterministic.
 *
 * Soft-fails to the input list on any DB error — graph expansion is
 * best-effort.
 */
export async function expandEntityIdsViaEdges(
  db: Surreal,
  logger: { warn: (msg: string) => void },
  entityIds: string[],
): Promise<string[]> {
  if (entityIds.length === 0) return entityIds;
  const rids = entityIds.map((raw) => {
    const id = raw.startsWith('knowledge_entity:')
      ? raw.slice('knowledge_entity:'.length)
      : raw;
    return new StringRecordId(`knowledge_entity:${id}`);
  });
  type Row = {
    id: unknown;
    outNeighbours: Array<{ peer: { id: unknown } | null }> | null;
    inNeighbours: Array<{ peer: { id: unknown } | null }> | null;
  };
  const out = new Set<string>();
  for (const id of entityIds) {
    out.add(id.startsWith('knowledge_entity:') ? id : `knowledge_entity:${id}`);
  }
  try {
    const [rows] = await db.query<[Row[]]>(
      `SELECT
             id,
             ->knowledge_edge.{ peer: out.{id} } AS outNeighbours,
             <-knowledge_edge.{ peer: in.{id} } AS inNeighbours
           FROM $ids`,
      { ids: rids },
    );
    for (const row of (rows as Row[]) ?? []) {
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
  } catch (err) {
    logger.warn(
      `expandEntityIdsViaEdges failed, falling back to input set: ${(err as Error).message}`,
    );
    return entityIds;
  }
  return [...out];
}
