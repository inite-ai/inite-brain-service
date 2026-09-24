import { Surreal, StringRecordId } from 'surrealdb';
import { isUniqueViolation, queryFirst } from '../db/surreal.service';

/** `knowledge_edge` row projection — only `id` is read back. */
interface EdgeIdRow {
  id: unknown;
}

/**
 * The scope half of an edge's identity, as the row computes it
 * (0153: `scopeKey = userId ?? ''`). Lookups key on it so a personal
 * edge and the tenant-global edge of the same triple are two rows.
 */
export function edgeScopeKey(userId: string | undefined): string {
  return userId ?? '';
}

export interface EdgeWrite {
  fromEntityId: string;
  toEntityId: string;
  kind: string;
  source: Record<string, unknown>;
  weight?: number;
  /** Per-user scope (0055): the edge belongs to this user's memory. */
  userId?: string | undefined;
}

/**
 * Create a knowledge_edge between two ALREADY-resolved entity IDs.
 * Idempotent within a scope: UNIQUE on (in, out, kind, scopeKey) —
 * concurrent / duplicate RELATEs return the existing edge id.
 *
 * The ONE edge-write primitive: the mention path, the document commit
 * path and the link API all write through it, so the scope stamp and
 * the idempotency rule cannot drift between copies.
 */
export async function createEdgeBetween(db: Surreal, p: EdgeWrite): Promise<string | null> {
  const fromRid = new StringRecordId(p.fromEntityId);
  const toRid = new StringRecordId(p.toEntityId);
  try {
    const edge = await queryFirst<EdgeIdRow>(
      db,
      `RELATE $from->knowledge_edge->$to CONTENT { kind: $kind, weight: $weight, source: $source, userId: $userId } RETURN AFTER`,
      {
        from: fromRid,
        to: toRid,
        kind: p.kind,
        weight: p.weight ?? 1.0,
        source: p.source,
        userId: p.userId,
      },
    );
    return edge ? String(edge.id) : null;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await queryFirst<EdgeIdRow>(
      db,
      `SELECT id FROM knowledge_edge WHERE in = $from AND out = $to AND kind = $kind AND scopeKey = $scopeKey LIMIT 1`,
      { from: fromRid, to: toRid, kind: p.kind, scopeKey: edgeScopeKey(p.userId) },
    );
    return existing ? String(existing.id) : null;
  }
}
