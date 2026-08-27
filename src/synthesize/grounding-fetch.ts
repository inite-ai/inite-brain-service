import { StringRecordId } from 'surrealdb';
import type { SurrealService } from '../db/surreal.service';
import type { GroundingFetchPort } from './answer-integrity';

/**
 * Ungrounded-support fetch port (EVIDENCE_UNGROUNDED_SERVING_GATE, 0115):
 * ONE batched by-id read of the cited facts' stored groundingStatus,
 * built over the service's @Optional SurrealService and handed to
 * resolveAnswerIntegrity behind the GroundingFetchPort type — so
 * answer-integrity stays DB-import-free and the orchestrator stays inside
 * its max-lines budget.
 *
 * The cited facts already passed every read fence when they were
 * retrieved and cited this request — this is a status re-read of that
 * same visible set, so the plain tenant connection suffices (the
 * answer-cache checkOnRead precedent for by-id cited-fact reads). Cheap
 * closure construction; resolveUngroundedSupport checks the flag BEFORE
 * calling, so flag-off issues no query. Undefined (no Surreal in the
 * fixture) ⇒ the gate arm is a guarded no-op.
 */
export function makeGroundingFetchPort(
  surreal: SurrealService | undefined,
): GroundingFetchPort | undefined {
  if (!surreal) return undefined;
  return (companyId, factIds) =>
    surreal.withCompany(companyId, async (db) => {
      // Record-id params — 3.x does not coerce string↔record; a malformed
      // (prefix-less) id is dropped rather than crashing the fetch, and a
      // fully-dropped set resolves to "serves" (fail-open).
      const ids = factIds.filter((id) => id.includes(':')).map((id) => new StringRecordId(id));
      if (ids.length === 0) return [];
      const [rows] = await db.query<[Array<{ groundingStatus?: unknown }>]>(
        `SELECT id, groundingStatus FROM knowledge_fact WHERE id INSIDE $ids`,
        { ids },
      );
      return rows ?? [];
    });
}
