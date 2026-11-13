import { StringRecordId } from 'surrealdb';
import { EMBEDDING_SPACE_FIELD } from '../ai/embedder/embedding-space';
import { idTailOf } from './ingest-utils';

/**
 * Post-resolve embedding-space stamp (migration 0101 column) — the
 * stampFactScope / stampGroundingStatus idiom, in its own module for the
 * resolver's max-lines budget. fn::settle_fact CREATEs the fact row with
 * the vector it was handed but has no space parameter, and redefining it
 * for one column would cost a migration and a signature change, so the
 * space id rides alongside the embedding through the write path and is set
 * here, keyed by the ids the call returned.
 *
 * Every non-NONE `factId` fn::settle_fact returns (0177) names the row it
 * just CREATEd with `$embedding` — CORROBORATED included (the standing row
 * is `corroboratedFactId`, never touched here) — so every returned id is
 * stamped. REJECTED / SKIPPED carry no id and stamp nothing.
 *
 * Best-effort: a failed stamp WARNs and never fails the ingest. The row
 * then reads NONE, the legacy / unknown space every pre-stamp row has —
 * the space migration re-embeds it like one, which is correct, merely
 * less targeted.
 */
export interface FactSpaceStampItem {
  factId: unknown;
  /** The space the row's vector was produced in; absent ⇒ nothing to stamp. */
  embeddingSpaceId?: string | undefined;
}

export async function stampFactEmbeddingSpace(args: {
  db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> };
  items: readonly FactSpaceStampItem[];
  logger: { warn(message: string): void };
}): Promise<void> {
  const bySpace = new Map<string, StringRecordId[]>();
  for (const it of args.items) {
    if (it.factId === undefined || it.factId === null || !it.embeddingSpaceId) continue;
    const ids = bySpace.get(it.embeddingSpaceId) ?? [];
    ids.push(new StringRecordId(`knowledge_fact:${idTailOf(String(it.factId))}`));
    bySpace.set(it.embeddingSpaceId, ids);
  }
  for (const [space, ids] of bySpace) {
    try {
      await args.db.query(`UPDATE $ids SET ${EMBEDDING_SPACE_FIELD} = $space`, { space, ids });
    } catch (e) {
      args.logger.warn(
        `embedding-space stamp failed for ${ids.length} fact(s) (non-fatal, rows read as ` +
          `legacy space): ${(e as Error).message}`,
      );
    }
  }
}
