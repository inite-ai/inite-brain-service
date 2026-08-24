import { Surreal, StringRecordId } from 'surrealdb';
import { isUniqueViolation, queryFirst } from '../db/surreal.service';

/** `knowledge_edge` row projection — only `id` is read back. */
interface EdgeIdRow {
  id: unknown;
}

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
  },
): Promise<string | null> {
  const fromRid = new StringRecordId(p.fromEntityId);
  const toRid = new StringRecordId(p.toEntityId);
  try {
    const edge = await queryFirst<EdgeIdRow>(
      db,
      `RELATE $from->knowledge_edge->$to CONTENT { kind: $kind, weight: $weight, source: $source } RETURN AFTER`,
      {
        from: fromRid,
        to: toRid,
        kind: p.kind,
        weight: 1.0,
        source: p.source,
      },
    );
    return edge ? String(edge.id) : null;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await queryFirst<EdgeIdRow>(
      db,
      `SELECT id FROM knowledge_edge WHERE in = $from AND out = $to AND kind = $kind LIMIT 1`,
      { from: fromRid, to: toRid, kind: p.kind },
    );
    return existing ? String(existing.id) : null;
  }
}
