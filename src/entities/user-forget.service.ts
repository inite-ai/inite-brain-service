import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';

/**
 * UserForgetService — GDPR erasure for a per-user memory scope
 * (migration 0055).
 *
 * The scope-field design makes user-forget a filtered cascade instead of
 * a database drop: every personal fact (including personal facts sitting
 * on SHARED entities), every personal entity with its edges and dedup
 * refs, the usage/feedback side tables keyed by those facts, and the
 * materialised audit_event mirror rows for facts, entities AND edges.
 *
 * Ordering is load-bearing: side tables and refs traverse record links
 * into the rows being erased, so they go FIRST — the traversal dies with
 * the target.
 *
 * NOT covered (no per-user linkage to filter on — documented GDPR gap):
 *   - debug_trace: a per-request ring buffer keyed by requestId, no
 *     userId column; TraceBufferService TTL-prunes it (bounded window).
 *   - ingest_dead_letter: rejected-ingest payloads carry no userId, so a
 *     REJECTED personal fact can't be selectively purged. Operators
 *     must sweep/redact dead-letter rows out of band. Adding a userId
 *     stamp at reject time (fn::resolve_fact et al.) would close this —
 *     tracked, not done here.
 */
export interface UserForgetResult {
  companyId: string;
  userId: string;
  factsDeleted: number;
  entitiesDeleted: number;
  edgesDeleted: number;
  auditEventsDeleted: number;
}

@Injectable()
export class UserForgetService {
  private readonly logger = new Logger(UserForgetService.name);

  constructor(private readonly surreal: SurrealService) {}

  async forgetUser(companyId: string, userId: string): Promise<UserForgetResult> {
    return this.surreal.withCompany(companyId, async (db) => {
      // Record ids first — the audit purge needs them AFTER the rows die.
      const [factIdRows] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM knowledge_fact WHERE userId = $u`,
        { u: userId },
      );
      const [entityIdRows] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM knowledge_entity WHERE userId = $u`,
        { u: userId },
      );
      const factIds = ((factIdRows as unknown[]) ?? []).map(String);
      const entityIds = ((entityIdRows as unknown[]) ?? []).map(String);

      // Every entity this user had a fact on — personal AND shared. Their
      // compiled dossiers (knowledge_artifact) may have baked in the
      // user's personal fact text, so they must go before the facts do.
      const [factEntityRows] = await db.query<[unknown[]]>(
        `SELECT VALUE entityId FROM knowledge_fact WHERE userId = $u`,
        { u: userId },
      );
      const touchedEntityIds = [...new Set(((factEntityRows as unknown[]) ?? []).map(String))];

      // Side tables keyed by fact records — traversal needs live facts.
      await db.query(`DELETE fact_usage WHERE factId.userId = $u`, {
        u: userId,
      });
      await db.query(`DELETE retrieval_feedback WHERE factId.userId = $u`, {
        u: userId,
      });
      // Edges touching a personal entity (either endpoint) or stamped
      // with the scope directly — before the entities go.
      const [edgesDeletedRows] = await db.query<[Array<{ id?: unknown }>]>(
        `DELETE knowledge_edge
          WHERE userId = $u OR in.userId = $u OR out.userId = $u
          RETURN BEFORE`,
        { u: userId },
      );
      const edgeRows = (edgesDeletedRows as Array<{ id?: unknown }>) ?? [];
      // Edges are mirrored to audit_event (changefeed-drain), so their
      // mirror rows must be purged with the fact/entity ones below.
      const edgeIds = edgeRows.map((r) => String(r.id)).filter((s) => s && s !== 'undefined');
      // Dedup refs traverse the entity link — before the entities go.
      await db.query(`DELETE entity_external_ref WHERE entity.userId = $u`, {
        u: userId,
      });
      // Compiled dossiers for every touched entity — personal ones die
      // with the entity, shared ones recompile clean (fenced to global
      // facts) on next read. Must precede the fact delete: entityId is a
      // record link the artifact carries independently, but doing it here
      // keeps the erasure atomic with the rest of the cascade.
      for (const eid of touchedEntityIds) {
        const tail = eid.startsWith('knowledge_entity:')
          ? eid.slice('knowledge_entity:'.length)
          : eid;
        await db.query(
          `DELETE knowledge_artifact
             WHERE entityId = type::record('knowledge_entity', $tail)`,
          { tail },
        );
      }

      await db.query(`DELETE knowledge_fact WHERE userId = $u`, { u: userId });
      await db.query(`DELETE knowledge_entity WHERE userId = $u`, {
        u: userId,
      });
      // L0 episode substrate (P1): user-scoped verbatim turns go with the
      // user. Episodes without a userId are tenant-global and follow the
      // tenant's own deletion path — the substrate redesign's forget≠
      // retention semantics (suppression list, derivation cascade) arrive
      // with the derivation registry (P3).
      const [epRows] = await db.query<[Array<{ id: unknown }>]>(
        `DELETE episode WHERE userId = $u RETURN BEFORE`,
        { u: userId },
      );
      // Segments quote those turns (audit W1, finding #13): a segment
      // carries userId only when the whole window is one user's, so
      // deleting by userId alone left mixed-user segments holding the
      // erased text plus dangling episodeIds. Delete by reference.
      const deletedEpisodeRefs = ((epRows as Array<{ id: unknown }>) ?? []).map(
        (r) => new StringRecordId(String(r.id)),
      );
      if (deletedEpisodeRefs.length > 0) {
        await db.query(`DELETE episode_segment WHERE episodeIds CONTAINSANY $eps`, {
          eps: deletedEpisodeRefs,
        });
      }
      await db.query(`DELETE episode_segment WHERE userId = $u`, { u: userId });

      // Scenes (0106, same finding-#13 class as segments): membership rows
      // traverse in.userId, so they go FIRST while their scene rows are
      // still alive. A user-scoped scene's members are all that user's by
      // the fold rule, so this clears them completely.
      await db.query(`DELETE memory_episode_member WHERE in.userId = $u`, { u: userId });
      // Mixed-user scenes carry no userId stamp — resolve them BY
      // REFERENCE through the membership of the just-deleted episodes
      // (the `out` link keeps its record id after the episode row died).
      // Erasure wins over retention: a scene quoting an erased turn goes
      // whole, exactly like a mixed-user segment.
      if (deletedEpisodeRefs.length > 0) {
        const [sceneIdRows] = await db.query<[unknown[]]>(
          `SELECT VALUE in FROM memory_episode_member WHERE out INSIDE $eps`,
          { eps: deletedEpisodeRefs },
        );
        const sceneIds = [...new Set(((sceneIdRows as unknown[]) ?? []).map(String))].map(
          (id) => new StringRecordId(id),
        );
        await db.query(
          `DELETE memory_episode_member WHERE in INSIDE $sceneIds OR out INSIDE $eps`,
          { sceneIds, eps: deletedEpisodeRefs },
        );
        if (sceneIds.length > 0) {
          await db.query(`DELETE memory_episode WHERE id INSIDE $sceneIds`, { sceneIds });
        }
      }
      await db.query(`DELETE memory_episode WHERE userId = $u`, { u: userId });

      // Purge the materialised audit mirror (same contract as entity
      // forget): recordId is the full `table:id` string. The changefeed
      // consumer's PII redaction covers any still-unconsumed lag.
      const recordIds = [...factIds, ...entityIds, ...edgeIds];
      let auditEventsDeleted = 0;
      if (recordIds.length > 0) {
        const [auditRows] = await db.query<[unknown[]]>(
          `DELETE audit_event WHERE recordId IN $ids RETURN BEFORE`,
          { ids: recordIds },
        );
        auditEventsDeleted = ((auditRows as unknown[]) ?? []).length;
      }

      const result: UserForgetResult = {
        companyId,
        userId,
        factsDeleted: factIds.length,
        entitiesDeleted: entityIds.length,
        edgesDeleted: edgeRows.length,
        auditEventsDeleted,
      };
      this.logger.log(
        `user forget ${companyId}/${userId}: facts=${result.factsDeleted} entities=${result.entitiesDeleted} edges=${result.edgesDeleted} audit=${result.auditEventsDeleted}`,
      );
      return result;
    });
  }
}
