import { StringRecordId, Surreal } from 'surrealdb';

/**
 * Shared document-purge helpers — the single home of the source_document /
 * source_chunk / candidate / indexer_run erase idioms, used by three
 * callers with different lifecycles:
 *
 *   * DocumentStoreService.purgeContent — operator-triggered content purge
 *     (chunks go, header + contentHash stay);
 *   * CandidateSweeperService — retainUntil retention sweeps (same shape);
 *   * the GDPR forget services (entity-forget / user-forget) — the
 *     fact-mediated document cascade (planDocumentCascade below), where
 *     EXCLUSIVE documents are fully erased, headers included.
 *
 * Every DELETE in this file is the two-step LET-select-ids → DELETE $ids
 * idiom, DELIBERATELY: on SurrealDB 3.2.4 a DELETE whose WHERE is planned
 * through a COMPOUND index (source_chunk_doc_idx (docId, seq) UNIQUE;
 * candidate/indexer_run docId is the same shape) can be a silent no-op —
 * returns OK, deletes nothing — while the same WHERE in a SELECT matches
 * fine. The bug class reproduced for preSweepOutcomeRows (PR #372).
 * Deleting by explicit ids sidesteps the planner entirely.
 */

/** Any handle that can run SurrealQL — a Surreal client or a tx facade. */
export type QueryHandle = Pick<Surreal, 'query'>;

/** Batch size for the chunk-purge loop (a doc's chunk count is unbounded). */
export const CHUNK_PURGE_BATCH = 5000;

/** 'source_document:<tail>' → '<tail>' (accepts a bare tail unchanged). */
function docTailOf(docId: string): string {
  return docId.includes(':') ? docId.slice(docId.indexOf(':') + 1) : docId;
}

/**
 * Delete a document's source_chunk rows in bounded batches (two-step
 * LET-then-DELETE — see the file docblock). Returns the number of chunk
 * rows actually deleted. The header row is NOT touched here.
 */
export async function purgeDocumentChunks(db: QueryHandle, docId: string): Promise<number> {
  let purged = 0;
  for (;;) {
    const [, batch] = await db.query<[unknown, unknown[]]>(
      `LET $ids = (SELECT VALUE id FROM source_chunk
         WHERE docId = type::record('source_document', $id)
         LIMIT ${CHUNK_PURGE_BATCH});
       DELETE $ids RETURN BEFORE`,
      { id: docTailOf(docId) },
    );
    const n = ((batch as unknown[]) ?? []).length;
    purged += n;
    // A partial batch means the document's chunks are drained.
    if (n < CHUNK_PURGE_BATCH) break;
  }
  return purged;
}

/**
 * Purging a document's text does NOT retract the facts committed from it —
 * the claims stay believed; what's gone is the reproducible evidence behind
 * them. Flag those facts (`source.provenancePurged = true`) so operators
 * and read paths can tell "grounded in retrievable text" from "source text
 * erased" instead of silently orphaning the provenance. Idempotent —
 * already-flagged facts are skipped; returns the number flagged. Shared by
 * all purge paths (explicit endpoint + retainUntil sweeper + GDPR forget).
 */
export async function markFactsProvenancePurged(db: QueryHandle, docId: string): Promise<number> {
  // Facts store the FULL record id string ('source_document:<tail>', see
  // commit-writer); accept a bare tail defensively.
  const fullId = docId.includes(':') ? docId : `source_document:${docId}`;
  const [rows] = await db.query<[Array<{ n: number }>]>(
    `SELECT count() AS n FROM knowledge_fact
      WHERE source.documentId = $docId AND source.provenancePurged != true
      GROUP ALL`,
    { docId: fullId },
  );
  const n = (rows as Array<{ n: number }>)?.[0]?.n ?? 0;
  if (n > 0) {
    await db.query(
      `UPDATE knowledge_fact SET source.provenancePurged = true
        WHERE source.documentId = $docId AND source.provenancePurged != true
        RETURN NONE`,
      { docId: fullId },
    );
  }
  return n;
}

/**
 * Identifies the forget subject inside a knowledge_fact WHERE clause.
 * `predicate` is a SurrealQL boolean expression over knowledge_fact rows
 * (e.g. `userId = $u` or `entityId = type::record('knowledge_entity', $rid)`);
 * `params` are its bindings. MUST NOT bind `$doc` or `$docs` — those names
 * are reserved by the cascade queries below.
 */
export interface ForgetSubjectKey {
  predicate: string;
  params: Record<string, unknown>;
}

/**
 * The fact-mediated document-cascade plan (all reads, no mutation).
 *
 * source_document carries NO userId/entityId (0048) — the ONLY linkage
 * from a forget subject to a document is knowledge_fact.source.documentId
 * on the subject's committed facts. So documents are forgettable exactly
 * to the extent committed facts tie them to the subject:
 *
 *   * EXCLUSIVE — no OTHER subject's fact references the doc → full purge
 *     (chunks, candidates, indexer_runs, header);
 *   * SHARED — another subject still grounds facts in it → the doc
 *     survives untouched (documented limit: there is no per-chunk
 *     attribution to erase selectively).
 */
export interface DocumentCascadePlan {
  /** Full 'source_document:<tail>' ids classified EXCLUSIVE to the subject. */
  exclusiveDocIds: string[];
  /** The same exclusive ids as bindable record refs. */
  exclusiveDocRefs: StringRecordId[];
  /** Docs the subject references that OTHER subjects still ground facts in. */
  sharedDocIds: string[];
  /** Sum of source_document.chunkCount over the exclusive docs (no chunk scan). */
  chunkCount: number;
  /** candidate rows keyed to the exclusive docs. */
  candidateCount: number;
  /** indexer_run rows keyed to the exclusive docs. */
  indexerRunCount: number;
}

/**
 * The exclusivity test for one document: counts committed facts that
 * reference the doc but do NOT belong to the subject. count = 0 →
 * EXCLUSIVE (full purge); count > 0 → SHARED (doc survives).
 * Exported as a pure builder so the shape is unit-testable.
 */
export function exclusivityCountQuery(subjectPredicate: string): string {
  return (
    `SELECT count() AS n FROM knowledge_fact ` +
    `WHERE source.documentId = $doc AND !(${subjectPredicate}) GROUP ALL`
  );
}

/**
 * Build the cascade plan. MUST run BEFORE the subject's facts are deleted:
 * source.documentId on those facts is the only document linkage, so once
 * the facts die the documents become unreachable (ordering constraint of
 * both forget services). Reads only — safe before any cap guard.
 */
export async function planDocumentCascade(
  db: QueryHandle,
  subject: ForgetSubjectKey,
): Promise<DocumentCascadePlan> {
  // Snapshot every doc the subject's facts ground in, deduped.
  const [docIdRows] = await db.query<[unknown[]]>(
    `SELECT VALUE source.documentId FROM knowledge_fact
      WHERE (${subject.predicate}) AND source.documentId != NONE`,
    subject.params,
  );
  const docIds = [...new Set(((docIdRows as unknown[]) ?? []).map(String))].filter((s) =>
    s.startsWith('source_document:'),
  );

  const exclusiveDocIds: string[] = [];
  const sharedDocIds: string[] = [];
  for (const docId of docIds) {
    const [rows] = await db.query<[Array<{ n: number }>]>(
      exclusivityCountQuery(subject.predicate),
      {
        ...subject.params,
        doc: docId,
      },
    );
    const others = (rows as Array<{ n: number }>)?.[0]?.n ?? 0;
    (others === 0 ? exclusiveDocIds : sharedDocIds).push(docId);
  }

  const exclusiveDocRefs = exclusiveDocIds.map((id) => new StringRecordId(id));
  let chunkCount = 0;
  let candidateCount = 0;
  let indexerRunCount = 0;
  if (exclusiveDocRefs.length > 0) {
    // Pre-count via the chunkCount column — no chunk scan.
    const [chunkRows] = await db.query<[Array<{ chunkCount: number }>]>(
      `SELECT chunkCount FROM $docs`,
      { docs: exclusiveDocRefs },
    );
    chunkCount = ((chunkRows as Array<{ chunkCount: number }>) ?? []).reduce(
      (sum, r) => sum + (r.chunkCount ?? 0),
      0,
    );
    const [candRows] = await db.query<[Array<{ n: number }>]>(
      `SELECT count() AS n FROM candidate WHERE docId INSIDE $docs GROUP ALL`,
      { docs: exclusiveDocRefs },
    );
    candidateCount = (candRows as Array<{ n: number }>)?.[0]?.n ?? 0;
    const [runRows] = await db.query<[Array<{ n: number }>]>(
      `SELECT count() AS n FROM indexer_run WHERE docId INSIDE $docs GROUP ALL`,
      { docs: exclusiveDocRefs },
    );
    indexerRunCount = (runRows as Array<{ n: number }>)?.[0]?.n ?? 0;
  }

  return {
    exclusiveDocIds,
    exclusiveDocRefs,
    sharedDocIds,
    chunkCount,
    candidateCount,
    indexerRunCount,
  };
}

/**
 * PRE-TX bulk leg of the exclusive-doc purge (unbounded volume, so it runs
 * OUTSIDE the erase transaction). Per doc: flag the committed facts
 * provenancePurged FIRST, then drain the chunks batched, then mark the
 * header purged — so a mid-sequence failure rests in the already-defined
 * purgeContent state ("facts believed, evidence purged"), never a novel
 * half-state. Returns chunk rows actually deleted.
 */
export async function purgeExclusiveDocContent(
  db: QueryHandle,
  plan: DocumentCascadePlan,
): Promise<number> {
  let purgedChunks = 0;
  for (const docId of plan.exclusiveDocIds) {
    await markFactsProvenancePurged(db, docId);
    purgedChunks += await purgeDocumentChunks(db, docId);
    await db.query(
      `UPDATE type::record('source_document', $id)
         SET status = 'purged', hasContent = false`,
      { id: docTailOf(docId) },
    );
  }
  return purgedChunks;
}

/**
 * Bounded, identity-bearing tail of the exclusive-doc purge for the
 * SEQUENTIAL (user-forget) path: candidates → indexer_runs → the
 * source_document headers, each by pre-selected ids (see file docblock).
 * The entity-forget path runs the same statements INSIDE its atomic
 * transaction instead — see entity-forget.service.ts.
 */
export async function deleteDocumentIdentityRows(
  db: QueryHandle,
  docRefs: StringRecordId[],
): Promise<{ candidates: number; indexerRuns: number; docs: number }> {
  if (docRefs.length === 0) return { candidates: 0, indexerRuns: 0, docs: 0 };
  const [, candDel] = await db.query<[unknown, unknown[]]>(
    `LET $candIds = (SELECT VALUE id FROM candidate WHERE docId INSIDE $docs);
     DELETE $candIds RETURN BEFORE`,
    { docs: docRefs },
  );
  const [, runDel] = await db.query<[unknown, unknown[]]>(
    `LET $runIds = (SELECT VALUE id FROM indexer_run WHERE docId INSIDE $docs);
     DELETE $runIds RETURN BEFORE`,
    { docs: docRefs },
  );
  const [docDel] = await db.query<[unknown[]]>(`DELETE $docs RETURN BEFORE`, { docs: docRefs });
  return {
    candidates: ((candDel as unknown[]) ?? []).length,
    indexerRuns: ((runDel as unknown[]) ?? []).length,
    docs: ((docDel as unknown[]) ?? []).length,
  };
}
