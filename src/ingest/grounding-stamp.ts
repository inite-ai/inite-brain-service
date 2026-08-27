import { StringRecordId } from 'surrealdb';
import { groundingStampEnabled } from '../common/evidence-flags';
import { groundingStatusOf } from '../common/grounding-status';
import { idTailOf } from './ingest-utils';

/**
 * Post-resolve grounding-status stamp (Drift-1, migration 0115) — the
 * stampFactScope/stampLangAttribution idiom, in its own module for the
 * resolver's max-lines budget: stamp `knowledge_fact.groundingStatus`
 * ('grounded' | 'ungrounded', computed by common/grounding-status.ts from
 * the fact's OWN source) onto the rows fn::resolve_fact created or
 * updated. Kept OUT of fn::resolve_fact so the resolver's pinned 25-arg
 * signature and invariants are untouched.
 *
 * Only winner rows are stamped — INSERTED / INSERTED_HISTORICAL /
 * SUPERSEDED / COMPETING (the outcomes whose factId names a row CREATED
 * by this resolve). CORROBORATED returns the STANDING row's id (no new
 * row; overwriting its status from the duplicate's source would let a
 * bare re-assertion flip a grounded claim) and REJECTED/SKIPPED create
 * nothing — all excluded.
 *
 * STAMPING ONLY, best-effort: a failure WARNs and never fails the ingest.
 * Residual risk (accepted by design): a failed stamp leaves the row
 * legacy-looking → served/promoted exactly as today — fail-safe, because
 * the consumption gates must never brick serving. Primary-key UPDATE per
 * row ($id record id, the stampLangAttribution form) — never a WHERE over
 * an indexed column (SurrealDB 3.2.4 compound-index planner rule).
 *
 * Flag off (EVIDENCE_GROUNDING_STAMP, default) ⇒ immediate return, no
 * query issued — the db call sequence is byte-identical.
 */
export interface GroundingStampItem {
  factId: unknown;
  outcome: unknown;
  source: unknown;
}

const STAMPABLE_OUTCOMES: ReadonlySet<string> = new Set([
  'INSERTED',
  'INSERTED_HISTORICAL',
  'SUPERSEDED',
  'COMPETING',
]);

export async function stampGroundingStatus(args: {
  db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
  items: readonly GroundingStampItem[];
  logger: { warn(message: string): void };
}): Promise<void> {
  if (!groundingStampEnabled()) return;
  const rows = args.items.filter(
    (it) =>
      it.factId !== undefined && it.factId !== null && STAMPABLE_OUTCOMES.has(String(it.outcome)),
  );
  if (rows.length === 0) return;
  try {
    for (const it of rows) {
      const id = new StringRecordId(`knowledge_fact:${idTailOf(String(it.factId))}`);
      await args.db.query(`UPDATE $id SET groundingStatus = $status`, {
        id,
        status: groundingStatusOf(it.source),
      });
    }
  } catch (e) {
    args.logger.warn(
      `grounding-status stamp failed (non-fatal, row stays legacy — served/promoted as today): ${(e as Error).message}`,
    );
  }
}
