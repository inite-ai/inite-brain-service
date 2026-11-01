/**
 * Edges in fact resolution (#834). An edge is a fact about both of its
 * entities (Graphiti, arXiv 2501.13956 §2.2.3), so a new open edge is
 * judged with the same prompt against the open edges that share an
 * endpoint with it, and a `replaces` closes the one whose valid time
 * started earlier, at the later one's start.
 *
 * Sharing EITHER endpoint is what covers both shapes a relation takes:
 * `sasha lives_in Lisbon` → `sasha lives_in Porto` share the subject;
 * `Diego leads sasha` → `Marta leads sasha` share the object. A per-kind
 * cardinality would have to know which side is single-valued.
 *
 * Before this, an edge closed only when the extractor named its handle in
 * a fact's `supersedes`, and a moved-out-of city stayed linked next to the
 * new one in every search.
 */
import { StringRecordId, type Surreal } from 'surrealdb';
import { isoString } from '../common/surreal-date';
import { RESOLUTION_CANDIDATES, type ResolvableFact } from './fact-resolution';

/** Open on both axes: still holds in the world, and memory still believes it. */
export const EDGE_OPEN = 'validUntil IS NONE AND invalidatedAt IS NONE';

export function isEdgeId(id: string): boolean {
  return id.startsWith('knowledge_edge:');
}

export interface OpenEdgeRow {
  id: unknown;
  in: unknown;
  out: unknown;
  kind: string;
  fromName?: unknown;
  toName?: unknown;
  validFrom?: unknown;
  createdAt: unknown;
  scopeKey?: unknown;
  sourceKind?: unknown;
  documentId?: unknown;
}

const EDGE_FIELDS = `id, in, out, kind, in.canonicalName AS fromName, out.canonicalName AS toName,
  validFrom, createdAt, scopeKey, source.kind AS sourceKind, source.documentId AS documentId`;

/**
 * An edge as the judge reads it: `kind: from → to`. An edge written before
 * valid time existed (0164) holds from when it was recorded.
 */
export function edgeResolvable(row: OpenEdgeRow, ofRecord: boolean): ResolvableFact {
  return {
    id: String(row.id),
    predicate: row.kind,
    object: `${String(row.fromName ?? '?')} → ${String(row.toName ?? '?')}`,
    validFrom: isoString(row.validFrom ?? row.createdAt),
    recordedAt: isoString(row.createdAt),
    ...(ofRecord ? { ofRecord: true } : {}),
  };
}

/** Pending open edges of one scope, oldest first. */
export async function pendingEdges(
  db: Surreal,
  opts: { scope: string; limit: number; offset: number; u: string | undefined },
): Promise<OpenEdgeRow[]> {
  const [rows] = await db.query<[OpenEdgeRow[]]>(
    `SELECT ${EDGE_FIELDS} FROM knowledge_edge
      WHERE resolutionCheckedAt IS NONE AND ${EDGE_OPEN} ${opts.scope}
      ORDER BY createdAt ASC LIMIT $k START $off`,
    { u: opts.u, k: opts.limit, off: opts.offset },
  );
  return rows ?? [];
}

/**
 * The open edges an edge is judged against: the same subject or the same
 * object, in the same scope (a personal edge never meets another user's),
 * newest first.
 */
export async function edgeCandidates(db: Surreal, row: OpenEdgeRow): Promise<OpenEdgeRow[]> {
  const [rows] = await db.query<[OpenEdgeRow[]]>(
    `SELECT ${EDGE_FIELDS} FROM knowledge_edge
      WHERE id != $id AND ${EDGE_OPEN} AND scopeKey = $sk AND (in = $in OR out = $out)
      ORDER BY createdAt DESC LIMIT $k`,
    { id: row.id, sk: row.scopeKey ?? '', in: row.in, out: row.out, k: RESOLUTION_CANDIDATES },
  );
  return rows ?? [];
}

/** Edges by id, open ones only (a closed one is no longer judged). */
export async function reloadEdges(db: Surreal, ids: string[]): Promise<OpenEdgeRow[]> {
  const [rows] = await db.query<[OpenEdgeRow[]]>(
    `SELECT ${EDGE_FIELDS} FROM $ids WHERE ${EDGE_OPEN}`,
    { ids: ids.map((id) => new StringRecordId(id)) },
  );
  return rows ?? [];
}

/**
 * Which of these edges a system of record wrote: its door decides its own
 * relations (#830 addendum), so no judgement closes them. Edges written
 * since #834 say so on `source.kind`; older ones are told by the document
 * they were read from.
 */
export async function recordEdgeIds(db: Surreal, rows: OpenEdgeRow[]): Promise<Set<string>> {
  const out = new Set(
    rows.filter((r) => r.sourceKind === 'source_record').map((r) => String(r.id)),
  );
  const docs = [...new Set(rows.flatMap((r) => (r.documentId ? [String(r.documentId)] : [])))];
  if (docs.length === 0) return out;
  const [records] = await db.query<[unknown[]]>(
    `SELECT VALUE id FROM $docs WHERE kind = 'source_record'`,
    { docs: docs.map((d) => new StringRecordId(d)) },
  );
  const recordDocs = new Set((records ?? []).map(String));
  for (const r of rows)
    if (r.documentId && recordDocs.has(String(r.documentId))) out.add(String(r.id));
  return out;
}

/**
 * Close an edge a later one replaced, at the replacement's start. The
 * knowledge axis closes too once that instant has passed (the same rule
 * the edge writer applies to a stated end, edgeTimeContent).
 */
export async function closeEdge(db: Surreal, loser: string, until: string): Promise<void> {
  await db.query(
    `UPDATE $id SET
        validUntil = $until,
        invalidatedAt = IF $until <= time::now() THEN invalidatedAt ?? time::now() ELSE invalidatedAt END
      WHERE ${EDGE_OPEN};`,
    { id: new StringRecordId(loser), until: new Date(until) },
  );
}
