import { StringRecordId, type Surreal } from 'surrealdb';
import { queryRows } from '../db/surreal.service';
import { documentRecordId, retireEdgeSupport } from '../ingest/edge-support';

/**
 * A new revision of a source item retires the claims it no longer makes
 * (#830). Until now the next revision wrote what it said (corroborating
 * the values it kept, superseding the ones it changed) and left everything
 * it dropped open forever: a deal unlinked from its company still pointed
 * there, a paragraph deleted from a page still answered questions.
 *
 * Kept, always: what this revision wrote, and the rows those corroborate.
 * A value restated from a new revision corroborates the row the first one
 * made, and that row stays open. What else closes depends on what the
 * revision can prove by leaving a claim out:
 *
 *  - a record render (`source_record`) is a closed world: it lists every
 *    field and relation the record has, so anything it no longer carries
 *    was cleared or unlinked in the source. Facts and edges close.
 *  - prose is an open world: a model re-reading a page may simply not
 *    restate a claim. A claim closes only when its justification is gone
 *    (truth maintenance): the verbatim clause it was read from
 *    (`source.clause`), or for an older row the turn it was grounded in
 *    (`source.episodeIds`), no longer appears in the new text. A claim
 *    whose passage is still there stays open, extracted again or not, and
 *    one with neither recorded stays open. Prose edges carry no passage,
 *    so a revision leaves them alone; they close when the item goes.
 *
 * Revisions are the item's earlier documents of the same kind and, for a
 * record's prose fields, the same field (each field is its own document).
 * Closing happens at this revision's time, the instant the source says it
 * changed. Edges go through their document support (0178): one another
 * live document still asserts stays open.
 */

/** records-door SOURCE_RECORD_KIND; documents does not import the source plane. */
const SOURCE_RECORD_KIND = 'source_record';
const OPEN = `status IN ['active', 'corroborating', 'competing'] AND validUntil IS NONE`;

export interface RetiredClaims {
  facts: number;
  edges: number;
}

export interface RevisionClosure {
  itemId: string;
  documentId: string;
  kind: string;
  /** A record's prose field (caller meta `record_field`); absent otherwise. */
  field?: string | undefined;
  at: Date;
  factIds: string[];
  edgeIds: string[];
}

interface OpenFactRow {
  id: unknown;
  corroborates?: unknown;
  validFrom?: unknown;
  episodeIds?: unknown;
  clause?: unknown;
}

export async function retireDroppedClaims(db: Surreal, p: RevisionClosure): Promise<RetiredClaims> {
  const closedWorld = p.kind === SOURCE_RECORD_KIND;
  const earlier = await earlierRevisions(db, p);
  if (earlier.length === 0) return { facts: 0, edges: 0 };
  const kept = await keptFacts(db, p.factIds);
  const text = closedWorld ? '' : await revisionText(db, p.documentId);
  // Prose with no stored text cannot show a passage is gone: nothing closes.
  if (!closedWorld && text.length === 0) return { facts: 0, edges: 0 };
  let facts = 0;
  for (const doc of earlier) {
    const rows = await queryRows<OpenFactRow>(
      db,
      `SELECT id, corroborates, validFrom, source.episodeIds AS episodeIds, source.clause AS clause FROM knowledge_fact
         WHERE source.documentId = $doc AND ${OPEN} LIMIT 1000`,
      { doc },
    );
    const candidates = rows.filter(
      (r) =>
        !kept.has(String(r.id)) &&
        !kept.has(String(r.corroborates ?? '')) &&
        !startsAfter(r.validFrom, p.at),
    );
    const retire = closedWorld ? candidates : await unjustified(db, candidates, text);
    if (retire.length > 0) {
      await db.query(`UPDATE $ids SET validUntil = $at`, {
        ids: retire.map((r) => new StringRecordId(String(r.id))),
        at: p.at,
      });
      facts += retire.length;
    }
  }
  const edges = closedWorld
    ? await retireEdgeSupport(db, { documentIds: earlier, at: p.at, keep: new Set(p.edgeIds) })
    : 0;
  return { facts, edges };
}

/** The item's earlier revisions: same kind (and field), not this one, not later. */
async function earlierRevisions(db: Surreal, p: RevisionClosure): Promise<string[]> {
  const self = documentRecordId(p.documentId);
  const rows = await queryRows<{ id: unknown; occurredAt?: unknown; field?: unknown }>(
    db,
    `SELECT id, occurredAt, meta.record_field AS field FROM source_document
       WHERE meta.sourceItemId = $itemId AND kind = $kind LIMIT 200 TIMEOUT 5s`,
    { itemId: p.itemId, kind: p.kind },
  );
  return rows
    .filter((r) => (typeof r.field === 'string' ? r.field : undefined) === p.field)
    .map((r) => ({ id: documentRecordId(String(r.id)), at: r.occurredAt }))
    .filter((r) => r.id !== self && !startsAfter(r.at, p.at))
    .map((r) => r.id);
}

async function keptFacts(db: Surreal, factIds: string[]): Promise<Set<string>> {
  const kept = new Set(factIds);
  if (factIds.length === 0) return kept;
  const targets = await queryRows<unknown>(
    db,
    `SELECT VALUE corroborates FROM $ids WHERE corroborates IS NOT NONE`,
    { ids: factIds.map((f) => new StringRecordId(f)) },
  );
  for (const t of targets) kept.add(String(t));
  return kept;
}

/** The new revision's stored text, whitespace-normalised. */
async function revisionText(db: Surreal, documentId: string): Promise<string> {
  const chunks = await queryRows<string>(
    db,
    `SELECT VALUE text FROM source_chunk WHERE docId = $doc ORDER BY seq`,
    { doc: new StringRecordId(documentRecordId(documentId)) },
  );
  return normalise(chunks.join('\n'));
}

/**
 * The facts whose justification is gone from the new text: the verbatim
 * clause they were read from when it was recorded, else every turn they
 * were grounded in. A fact with neither stays open.
 */
async function unjustified(db: Surreal, rows: OpenFactRow[], text: string): Promise<OpenFactRow[]> {
  const byClause = rows.filter((r) => typeof r.clause === 'string' && r.clause.trim().length > 0);
  const byTurn = rows.filter((r) => !byClause.includes(r));
  const gone = byClause.filter((r) => !text.includes(normalise(String(r.clause))));
  const episodes = [...new Set(byTurn.flatMap((r) => strings(r.episodeIds)))];
  if (episodes.length === 0) return gone;
  const passages = await queryRows<{ id: unknown; text?: unknown }>(
    db,
    `SELECT id, text FROM $ids`,
    {
      ids: episodes.map((e) => new StringRecordId(e)),
    },
  );
  const present = new Map(
    passages.map((e) => [
      String(e.id),
      typeof e.text === 'string' && text.includes(normalise(e.text)),
    ]),
  );
  return [
    ...gone,
    ...byTurn.filter((r) => {
      const eps = strings(r.episodeIds);
      return eps.length > 0 && eps.every((e) => present.get(e) === false);
    }),
  ];
}

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function startsAfter(v: unknown, at: Date): boolean {
  if (v == null) return false;
  const ms = new Date(v as string | Date).getTime();
  return !Number.isNaN(ms) && ms > at.getTime();
}
