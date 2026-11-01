import { StringRecordId, type Surreal } from 'surrealdb';
import { queryRows } from '../db/surreal.service';
import { documentRecordId, retireEdgeSupport } from '../ingest/edge-support';

/**
 * A record revision retires the claims it no longer makes (#830).
 *
 * A system of record is a closed world: its render lists every field and
 * relation the record has, so a field cleared or a link removed in the
 * source is a change, not an omission. Until now the next revision wrote
 * what it said (corroborating the values it kept, superseding the ones it
 * changed) and left everything it dropped open forever: a deal unlinked
 * from its company still pointed there.
 *
 * Only `source_record` renders. A prose document re-extracted by a model
 * proves nothing by leaving a claim out (open world), and the record's
 * prose fields are documents of their own kind, untouched here.
 *
 * Kept = what this revision wrote, and the rows those corroborate: a
 * value restated from a new revision corroborates the row the first one
 * made, and that row stays open. Everything else still open on an earlier
 * revision of the same item closes at this revision's time, the instant
 * the source says it changed. Edges go through their document support
 * (0178): one another live document still asserts stays open.
 */

/** records-door SOURCE_RECORD_KIND; documents does not import the source plane. */
const SOURCE_RECORD_KIND = 'source_record';
const OPEN = `status IN ['active', 'corroborating', 'competing'] AND validUntil IS NONE`;

export interface RetiredClaims {
  facts: number;
  edges: number;
}

export async function retireDroppedClaims(
  db: Surreal,
  p: {
    itemId: string;
    documentId: string;
    at: Date;
    factIds: string[];
    edgeIds: string[];
  },
): Promise<RetiredClaims> {
  const earlier = await earlierRevisions(db, p);
  if (earlier.length === 0) return { facts: 0, edges: 0 };
  const kept = await keptFacts(db, p.factIds);
  let facts = 0;
  for (const doc of earlier) {
    const rows = await queryRows<{ id: unknown; corroborates?: unknown; validFrom?: unknown }>(
      db,
      `SELECT id, corroborates, validFrom FROM knowledge_fact
         WHERE source.documentId = $doc AND ${OPEN} LIMIT 1000`,
      { doc },
    );
    const retire = rows
      .filter((r) => !kept.has(String(r.id)) && !kept.has(String(r.corroborates ?? '')))
      .filter((r) => !startsAfter(r.validFrom, p.at))
      .map((r) => new StringRecordId(String(r.id)));
    if (retire.length > 0) {
      await db.query(`UPDATE $ids SET validUntil = $at`, { ids: retire, at: p.at });
      facts += retire.length;
    }
  }
  const edges = await retireEdgeSupport(db, {
    documentIds: earlier,
    at: p.at,
    keep: new Set(p.edgeIds),
  });
  return { facts, edges };
}

/** The item's earlier record renders: not this one, and not later than it. */
async function earlierRevisions(
  db: Surreal,
  p: { itemId: string; documentId: string; at: Date },
): Promise<string[]> {
  const self = documentRecordId(p.documentId);
  const rows = await queryRows<{ id: unknown; occurredAt?: unknown }>(
    db,
    `SELECT id, occurredAt FROM source_document
       WHERE meta.sourceItemId = $itemId AND kind = $kind LIMIT 200 TIMEOUT 5s`,
    { itemId: p.itemId, kind: SOURCE_RECORD_KIND },
  );
  return rows
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

function startsAfter(v: unknown, at: Date): boolean {
  if (v == null) return false;
  const ms = new Date(v as string | Date).getTime();
  return !Number.isNaN(ms) && ms > at.getTime();
}
