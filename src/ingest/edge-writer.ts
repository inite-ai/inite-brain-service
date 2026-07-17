import { Surreal, StringRecordId } from 'surrealdb';
import { isUniqueViolation } from '../db/surreal.service';

/**
 * Create a knowledge_edge between two ALREADY-resolved entity IDs.
 * Idempotent: UNIQUE on (in, out, kind) — concurrent / duplicate RELATEs
 * return the existing edge id.
 *
 * Extracted verbatim from MentionPersistService (stateless, so a plain
 * function, not an @Injectable) so the document commit path and the
 * mention path share ONE edge-write primitive instead of drifting copies.
 */
export async function createEdgeBetween(
  db: Surreal,
  p: {
    fromEntityId: string;
    toEntityId: string;
    kind: string;
    source: Record<string, unknown>;
    /** User scope (0055). Stamped onto the edge so a personal social link
     *  (e.g. persona family_of) is fenced to the same user + tenant-global
     *  reads. Omitted → tenant-global, unchanged. */
    userId?: string;
  },
): Promise<string | null> {
  const fromRid = new StringRecordId(p.fromEntityId);
  const toRid = new StringRecordId(p.toEntityId);
  // `option<string>` rejects NULL — the global path must OMIT userId (drops
  // to NONE), never set it to null, so unscoped edges stay byte-identical.
  const content: Record<string, unknown> = {
    kind: p.kind,
    weight: 1.0,
    source: p.source,
    ...(p.userId ? { userId: p.userId } : {}),
  };
  try {
    const [edgeRows] = await db.query<[any[]]>(
      `RELATE $from->knowledge_edge->$to CONTENT $content RETURN AFTER`,
      {
        from: fromRid,
        to: toRid,
        content,
      },
    );
    const edge = ((edgeRows as any[]) ?? [])[0];
    return edge ? String(edge.id) : null;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const [existingRows] = await db.query<[any[]]>(
      `SELECT id FROM knowledge_edge WHERE in = $from AND out = $to AND kind = $kind LIMIT 1`,
      { from: fromRid, to: toRid, kind: p.kind },
    );
    const existing = ((existingRows as any[]) ?? [])[0];
    return existing ? String(existing.id) : null;
  }
}
