import { StringRecordId, type Surreal } from 'surrealdb';
import { queryRows } from '../db/surreal.service';
import { idTailOf } from './ingest-utils';

/**
 * Which documents still assert an edge (0178). A document-born edge used to
 * remember only the first document that stated it, so a gone item or a
 * record revision that dropped the relation could not tell whether anyone
 * else still said it, and the edge stayed open forever. Facts never had
 * the gap: every restatement is a corroborating row of its own. An edge is
 * one row per (in, out, kind, scope), so its grounding is a set on the row:
 *
 *   source.documentIds         every document that asserted it
 *   source.retiredDocumentIds  those that no longer do (gone, or revised
 *                              without the claim); the edge is grounded
 *                              while the first set has a member the second
 *                              lacks, and closes when none is left
 *   source.undocumented        also stated outside any document; document
 *                              lifecycle never closes it
 *   source.retiredAt           the instant document lifecycle closed it
 *
 * Retiring keeps the document in `documentIds`, so a returning item finds
 * its edges through the same element index.
 *
 * SurrealDB 3.2.4: SELECT the ids, then UPDATE $ids (UPDATE … WHERE over
 * an indexed field is a silent no-op), and `CONTAINS` one document at a
 * time, the only operator that plans the element index.
 */

const PAGE = 200;

export function documentRecordId(documentId: string): string {
  return `source_document:${idTailOf(documentId)}`;
}

/** The support a newly written edge starts with. */
export function withDocumentSupport<S extends { documentId?: unknown }>(
  source: S,
): S & { documentIds?: string[] } {
  return typeof source.documentId === 'string'
    ? { ...source, documentIds: [documentRecordId(source.documentId)] }
    : source;
}

/**
 * A restatement landing on an existing row. From a document: the document
 * joins the set, and an edge the lifecycle had closed reopens — the claim
 * is made again. From anywhere else: the edge is marked undocumented, so no
 * document going away can close what a conversation also said.
 */
export async function addEdgeSupport(
  db: Surreal,
  edgeId: string,
  source: { documentId?: unknown },
): Promise<void> {
  const id = new StringRecordId(edgeId);
  if (typeof source.documentId !== 'string') {
    await markUndocumented(db, [edgeId]);
    return;
  }
  await db.query(
    `UPDATE $id SET
         source.documentIds = array::union(
           source.documentIds ?? (IF source.documentId IS NONE THEN [] ELSE [<string> source.documentId] END),
           [$doc]),
         source.retiredDocumentIds = array::complement(source.retiredDocumentIds ?? [], [$doc]);
     UPDATE $id SET validUntil = NONE, source.retiredAt = NONE
         WHERE source.retiredAt IS NOT NONE AND validUntil = source.retiredAt;`,
    { id, doc: documentRecordId(source.documentId) },
  );
}

/** Edges a conversation restated: document lifecycle leaves them alone. */
export async function markUndocumented(db: Surreal, edgeIds: string[]): Promise<void> {
  if (edgeIds.length === 0) return;
  await db.query(
    `UPDATE $ids SET source.undocumented = true
         WHERE source.documentId IS NOT NONE AND source.undocumented != true`,
    { ids: edgeIds.map((e) => new StringRecordId(e)) },
  );
}

interface SupportedEdgeRow {
  id: unknown;
  documentIds?: unknown;
  retired?: unknown;
  undocumented?: unknown;
  retiredAt?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  invalidatedAt?: unknown;
}

/** Every edge one document asserted, a page at a time. */
async function* edgesAssertedBy(db: Surreal, doc: string): AsyncGenerator<SupportedEdgeRow> {
  for (let start = 0; ; start += PAGE) {
    const rows = await queryRows<SupportedEdgeRow>(
      db,
      `SELECT id, source.documentIds AS documentIds, source.retiredDocumentIds AS retired,
              source.undocumented AS undocumented, source.retiredAt AS retiredAt,
              validFrom, validUntil, invalidatedAt
         FROM knowledge_edge WHERE source.documentIds CONTAINS $doc LIMIT ${PAGE} START ${start}`,
      { doc },
    );
    yield* rows;
    if (rows.length < PAGE) return;
  }
}

/**
 * The documents stop asserting their edges at `at`. An edge left with no
 * live document and no other support closes at `at`. `keep` names edges
 * the caller just re-asserted (a record revision's own relations). Returns
 * the number of edges closed.
 */
export async function retireEdgeSupport(
  db: Surreal,
  p: { documentIds: string[]; at: Date; keep?: ReadonlySet<string> },
): Promise<number> {
  const docs = [...new Set(p.documentIds.map(documentRecordId))];
  const done = new Set<string>();
  let closed = 0;
  for (const doc of docs) {
    for await (const r of edgesAssertedBy(db, doc)) {
      const id = String(r.id);
      if (done.has(id) || p.keep?.has(id)) continue;
      done.add(id);
      if (await retireOne(db, r, { docs, at: p.at })) closed++;
    }
  }
  return closed;
}

async function retireOne(
  db: Surreal,
  r: SupportedEdgeRow,
  { docs, at }: { docs: string[]; at: Date },
): Promise<boolean> {
  const asserted = strings(r.documentIds);
  const retired = [
    ...new Set([...strings(r.retired), ...docs.filter((d) => asserted.includes(d))]),
  ];
  const closes =
    asserted.every((d) => retired.includes(d)) &&
    r.undocumented !== true &&
    r.validUntil == null &&
    r.invalidatedAt == null &&
    !startsAfter(r.validFrom, at);
  await db.query(
    closes
      ? `UPDATE $id SET source.retiredDocumentIds = $retired, validUntil = $at, source.retiredAt = $at`
      : `UPDATE $id SET source.retiredDocumentIds = $retired`,
    { id: new StringRecordId(String(r.id)), retired, at },
  );
  return closes;
}

/**
 * The inverse, for an item seen again byte-identical (its documents are
 * deduplicated, so nothing re-asserts the edges): each document is live
 * again, and the edges the lifecycle closed at exactly `at` reopen.
 * Returns the number reopened.
 */
export async function restoreEdgeSupport(
  db: Surreal,
  p: { documentIds: string[]; at: Date },
): Promise<number> {
  const docs = [...new Set(p.documentIds.map(documentRecordId))];
  const done = new Set<string>();
  let reopened = 0;
  for (const doc of docs) {
    for await (const r of edgesAssertedBy(db, doc)) {
      const id = String(r.id);
      if (done.has(id) || !strings(r.retired).includes(doc)) continue;
      done.add(id);
      const reopen = sameInstant(r.retiredAt, p.at) && sameInstant(r.validUntil, p.at);
      await db.query(
        reopen
          ? `UPDATE $id SET source.retiredDocumentIds = $retired, validUntil = NONE, source.retiredAt = NONE`
          : `UPDATE $id SET source.retiredDocumentIds = $retired`,
        {
          id: new StringRecordId(id),
          retired: strings(r.retired).filter((d) => !docs.includes(d)),
        },
      );
      if (reopen) reopened++;
    }
  }
  return reopened;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function startsAfter(validFrom: unknown, at: Date): boolean {
  if (validFrom == null) return false;
  const ms = new Date(validFrom as string | Date).getTime();
  return !Number.isNaN(ms) && ms > at.getTime();
}

function sameInstant(v: unknown, at: Date): boolean {
  if (v == null) return false;
  return new Date(v as string | Date).getTime() === at.getTime();
}
