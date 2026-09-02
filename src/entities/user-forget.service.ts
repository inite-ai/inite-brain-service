import { Injectable, Logger, Optional } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EvidenceStoreService } from '../evidence/evidence-store.service';
import {
  deleteDocumentIdentityRows,
  planDocumentCascade,
  purgeExclusiveDocContent,
} from '../documents/document-purge.util';

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
 *
 * Document cascade (fact-mediated) — HONEST LIMITS. source_document has
 * no userId/entityId (0048); the only subject→document linkage is
 * knowledge_fact.source.documentId on the user's committed facts, so the
 * cascade purges exactly the documents those facts tie to the user (see
 * planDocumentCascade). What it can NOT do:
 *   - SHARED documents (another subject still grounds facts in them)
 *     survive WITH their content — no per-chunk attribution to erase
 *     selectively. Mitigations: the retainUntil retention sweeper, and
 *     an operator DELETE /v1/documents/:id/content for targeted purges.
 *   - Documents that produced ZERO committed facts for the user are
 *     unreachable from here (nothing links them to the user).
 *   - candidate payloads mentioning the user in free text only are not
 *     attributable (no userId column on candidate).
 */
export interface UserForgetResult {
  companyId: string;
  userId: string;
  factsDeleted: number;
  entitiesDeleted: number;
  edgesDeleted: number;
  auditEventsDeleted: number;
  /** Semantic beliefs (0120): promoted belief rows erased with the user. */
  beliefsDeleted: number;
  /** Evidence substrate (0109): content-bearing rows erased with the user. */
  evidenceAssetsDeleted: number;
  evidenceFragmentsDeleted: number;
  representationsDeleted: number;
  /** source_document headers fully erased (EXCLUSIVE to this user). */
  purgedSourceDocs: number;
  /** source_chunk rows drained from those exclusive docs. */
  purgedSourceChunks: number;
  /** candidate rows erased with those exclusive docs. */
  purgedCandidates: number;
  /** indexer_run rows erased with those exclusive docs. */
  purgedIndexerRuns: number;
}

@Injectable()
export class UserForgetService {
  private readonly logger = new Logger(UserForgetService.name);

  constructor(
    private readonly surreal: SurrealService,
    // Blob deletion only — the ROW cascade below runs inline SQL so a
    // fixture constructed without the evidence module still erases rows.
    @Optional() private readonly evidence?: EvidenceStoreService,
  ) {}

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
      // fact_usage stays one-step: its factId carries a single-field
      // UNIQUE index, the verified-working shape on the pinned server.
      await db.query(`DELETE fact_usage WHERE factId.userId = $u`, {
        u: userId,
      });
      // Two-step (SELECT ids → DELETE $ids) DELIBERATELY: on SurrealDB
      // 3.2.4 a DELETE whose WHERE traverses through factId — covered by
      // the COMPOUND (factId, actor) UNIQUE index — silently matches
      // NOTHING (returns OK, deletes zero rows) while the same WHERE in
      // a SELECT matches fine — reproduced 12/12 against the pinned
      // server. Deleting by explicit ids sidesteps the planner entirely.
      // Same bug class as preSweepOutcomeRows (PR #372) / scene
      // membership (PR #370).
      const [feedbackIds] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM retrieval_feedback WHERE factId.userId = $u`,
        { u: userId },
      );
      if (((feedbackIds as unknown[]) ?? []).length > 0) {
        await db.query(`DELETE $ids`, { ids: feedbackIds });
      }
      // Outcome telemetry (0107): both tables traverse subjectId into
      // the user's facts — purge while the facts are alive, same as
      // fact_usage above. LET-then-DELETE-by-ids, NOT `DELETE … WHERE`:
      // on SurrealDB 3.2.4 a DELETE whose WHERE traverses through an
      // indexed record field (memory_outcome_subject_idx covers
      // subjectId) silently matches NOTHING, while the same WHERE in a
      // SELECT matches fine — verified against the pinned server.
      await db.query(
        `LET $outIds = (SELECT VALUE id FROM memory_outcome WHERE subjectId.userId = $u);
         DELETE $outIds;
         LET $outStatIds = (SELECT VALUE id FROM memory_outcome_stat WHERE subjectId.userId = $u);
         DELETE $outStatIds;`,
        { u: userId },
      );
      // Edges touching a personal entity (either endpoint) or stamped
      // with the scope directly — before the entities go. Same two-step
      // idiom DEFENSIVELY: the in.userId/out.userId arms traverse record
      // fields with compound coverage (edge_unique_idx) into the indexed
      // entity_user_idx — the exact reproduced trigger combination; the
      // one-step form only works today because the OR keeps the planner
      // off the index, and that choice is plan-dependent.
      const [edgeIdRows] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM knowledge_edge
          WHERE userId = $u OR in.userId = $u OR out.userId = $u`,
        { u: userId },
      );
      const edgeRecordIds = (edgeIdRows as unknown[]) ?? [];
      if (edgeRecordIds.length > 0) {
        await db.query(`DELETE $ids`, { ids: edgeRecordIds });
      }
      // Edges are mirrored to audit_event (changefeed-drain), so their
      // mirror rows must be purged with the fact/entity ones below.
      const edgeIds = edgeRecordIds.map(String).filter((s) => s && s !== 'undefined');
      // Dedup refs traverse the entity link — before the entities go.
      await db.query(`DELETE entity_external_ref WHERE entity.userId = $u`, {
        u: userId,
      });
      // Compiled dossiers for every touched entity — personal ones die
      // with the entity, shared ones recompile clean (fenced to global
      // facts) on next read. Must precede the fact delete: entityId is a
      // record link the artifact carries independently, but doing it here
      // keeps the erasure atomic with the rest of the cascade.
      // Two-step: knowledge_artifact.entityId is covered ONLY by the
      // COMPOUND (entityId, artifactType) UNIQUE index — the risky 3.2.4
      // planner shape (see the retrieval_feedback comment above); the
      // one-step DELETE passed probes but the failure is plan-dependent,
      // so it is hardened defensively.
      for (const eid of touchedEntityIds) {
        const tail = eid.startsWith('knowledge_entity:')
          ? eid.slice('knowledge_entity:'.length)
          : eid;
        const [artifactIds] = await db.query<[unknown[]]>(
          `SELECT VALUE id FROM knowledge_artifact
             WHERE entityId = type::record('knowledge_entity', $tail)`,
          { tail },
        );
        if (((artifactIds as unknown[]) ?? []).length > 0) {
          await db.query(`DELETE $ids`, { ids: artifactIds });
        }
      }

      // ── Document cascade (fact-mediated — see the file docblock's
      // HONEST LIMITS). MUST run BEFORE the fact delete below: the facts'
      // source.documentId is the only user→document linkage. Sequence per
      // exclusive doc: provenance flag FIRST, then the batched chunk
      // drain + header purge (a mid-failure rests in the defined
      // purgeContent state), then the bounded identity rows — candidates,
      // indexer_runs, headers — by pre-selected ids (3.2.4 planner
      // contract, see document-purge.util).
      const docPlan = await planDocumentCascade(db, {
        predicate: 'userId = $u',
        params: { u: userId },
      });
      const purgedSourceChunks = await purgeExclusiveDocContent(db, docPlan);
      const docRows = await deleteDocumentIdentityRows(db, docPlan.exclusiveDocRefs);

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
      //
      // Two-step (SELECT ids → DELETE $ids) DELIBERATELY: on SurrealDB
      // 3.2.4 a DELETE whose WHERE traverses through an indexed record
      // field silently matches NOTHING, while the same WHERE in a SELECT
      // matches fine — verified against the pinned server, and for `in`
      // (covered only by the COMPOUND scene_member_uq index) even a
      // direct `in INSIDE $ids` DELETE no-ops. Deleting by explicit ids
      // sidesteps the planner entirely. Same bug class as PR #372's
      // preSweepOutcomeRows in entity-forget.service.ts.
      const [ownMemberIds] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM memory_episode_member WHERE in.userId = $u`,
        { u: userId },
      );
      if (((ownMemberIds as unknown[]) ?? []).length > 0) {
        await db.query(`DELETE $ids`, { ids: ownMemberIds });
      }
      // Typed support graph (0116): every dying scene is a possible
      // supported_by edge target, so scene ids are collected BEFORE
      // their rows go (the edge erase below goes by these explicit
      // ids). User-scoped scenes here; mixed-user scenes join the list
      // in the by-reference branch below.
      const [ownSceneIdRows] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM memory_episode WHERE userId = $u`,
        { u: userId },
      );
      const supportSceneIds = ((ownSceneIdRows as unknown[]) ?? []).map(String);
      // Mixed-user scenes carry no userId stamp — resolve them BY
      // REFERENCE through the membership of the just-deleted episodes
      // (the `out` link keeps its record id after the episode row died).
      // Erasure wins over retention: a scene quoting an erased turn goes
      // whole, exactly like a mixed-user segment. Same two-step idiom:
      // the `in INSIDE` leg of a DELETE is dead on 3.2.4 (see above).
      if (deletedEpisodeRefs.length > 0) {
        const [sceneIdRows] = await db.query<[unknown[]]>(
          `SELECT VALUE in FROM memory_episode_member WHERE out INSIDE $eps`,
          { eps: deletedEpisodeRefs },
        );
        const sceneIds = [...new Set(((sceneIdRows as unknown[]) ?? []).map(String))].map(
          (id) => new StringRecordId(id),
        );
        supportSceneIds.push(...sceneIds.map(String));
        const [refMemberIds] = await db.query<[unknown[]]>(
          `SELECT VALUE id FROM memory_episode_member WHERE in INSIDE $sceneIds OR out INSIDE $eps`,
          { sceneIds, eps: deletedEpisodeRefs },
        );
        if (((refMemberIds as unknown[]) ?? []).length > 0) {
          await db.query(`DELETE $ids`, { ids: refMemberIds });
        }
        if (sceneIds.length > 0) {
          await db.query(`DELETE memory_episode WHERE id INSIDE $sceneIds`, { sceneIds });
        }
      }
      await db.query(`DELETE memory_episode WHERE userId = $u`, { u: userId });

      // Semantic beliefs (0120): ids pre-collected here so the
      // belief-side memory_support edges join the subject list below
      // BEFORE the rows die — see collectBeliefIds.
      const beliefIds = await this.collectBeliefIds(db, userId, supportSceneIds);

      // Typed support graph (0116): erase every memory_support edge
      // touching the user's facts (either endpoint), a dying scene
      // (edge target) or a dying belief (0120 edges: supported_by /
      // contradicted_by / derived_from with a belief endpoint). Runs
      // UNCONDITIONALLY — rows written while
      // PROVENANCE_SUPPORT_EDGES was on must stay erasable after it is
      // off (the EVIDENCE_SUBSTRATE_ENABLED precedent). Two-step
      // (SELECT ids → DELETE $ids) MANDATORY: `in` is covered by the
      // COMPOUND support_edge_uq index — `DELETE memory_support WHERE
      // in INSIDE …` is the reproduced 3.2.4 silent planner no-op (OK,
      // zero rows) while the same WHERE in a SELECT matches fine.
      const supportSubjects = [...factIds, ...new Set(supportSceneIds), ...beliefIds].map(
        (id) => new StringRecordId(id),
      );
      if (supportSubjects.length > 0) {
        await db.query(
          `LET $supIds = (SELECT VALUE id FROM memory_support
             WHERE in INSIDE $subjects OR out INSIDE $subjects);
           DELETE $supIds;`,
          { subjects: supportSubjects },
        );
      }

      // Belief rows go AFTER their edges (the edge SELECT above needs no
      // live row, but the order keeps the dependency reading honest).
      await this.eraseBeliefRows(db, beliefIds);

      // Evidence substrate (0109) — see eraseEvidenceRows.
      const { evidenceAssetsDeleted, evidenceFragmentsDeleted, representationsDeleted } =
        await this.eraseEvidenceRows(db, companyId, userId);

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
        edgesDeleted: edgeRecordIds.length,
        auditEventsDeleted,
        beliefsDeleted: beliefIds.length,
        evidenceAssetsDeleted,
        evidenceFragmentsDeleted,
        representationsDeleted,
        purgedSourceDocs: docRows.docs,
        purgedSourceChunks,
        purgedCandidates: docRows.candidates,
        purgedIndexerRuns: docRows.indexerRuns,
      };
      this.logger.log(
        `user forget ${companyId}/${userId}: facts=${result.factsDeleted} entities=${result.entitiesDeleted} edges=${result.edgesDeleted} audit=${result.auditEventsDeleted} beliefs=${result.beliefsDeleted} ` +
          `evidenceAssets=${result.evidenceAssetsDeleted} evidenceFragments=${result.evidenceFragmentsDeleted} representations=${result.representationsDeleted} ` +
          `docs=${result.purgedSourceDocs} chunks=${result.purgedSourceChunks} candidates=${result.purgedCandidates} indexerRuns=${result.purgedIndexerRuns}`,
      );
      return result;
    });
  }

  /**
   * Semantic beliefs (0120): a belief ALWAYS carries the single-user
   * scope of its scenes (the promotion skips mixed-user/legacy scene
   * groups fail-closed, #387), so the userId leg is the primary erase;
   * the sourceSceneIds leg defensively catches any belief referencing a
   * scene dying in this cascade (erasure wins over retention —
   * CONTAINSANY over an empty ref list matches nothing, so the userId
   * leg carries a scene-less cascade). Runs UNCONDITIONALLY — rows
   * written while SCENES_BELIEF_PROMOTION was on must stay erasable
   * after it is off (the EVIDENCE_SUBSTRATE_ENABLED precedent).
   */
  private async collectBeliefIds(
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> },
    userId: string,
    sceneIds: string[],
  ): Promise<string[]> {
    const [rows] = await db.query<[unknown[]]>(
      `SELECT VALUE id FROM semantic_belief
        WHERE userId = $u OR sourceSceneIds CONTAINSANY $scenes`,
      {
        u: userId,
        scenes: [...new Set(sceneIds)].map((id) => new StringRecordId(id)),
      },
    );
    return ((rows as unknown[]) ?? []).map(String);
  }

  /**
   * Two-step leg of the belief erase (0120 pins a repo-wide
   * `DELETE semantic_belief WHERE` prohibition — the 3.2.4 planner
   * class): the ids were pre-collected by collectBeliefIds.
   */
  private async eraseBeliefRows(
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> },
    beliefIds: string[],
  ): Promise<void> {
    if (beliefIds.length === 0) return;
    await db.query(`DELETE $ids`, {
      ids: beliefIds.map((id) => new StringRecordId(id)),
    });
  }

  /**
   * Evidence substrate (0109): assets are user/tenant-scoped, so a
   * user's assets die with them — with their fragments and derived
   * representations (both content-bearing: labels, captions, OCR/ASR
   * text). Blob refs are collected BEFORE the rows die (the row is the
   * only pointer). LET-then-DELETE-by-ids, NOT `DELETE … WHERE`: the
   * fragment/representation WHEREs traverse indexed record fields — the
   * reproduced 3.2.4 planner no-op class (see the memory_outcome comment
   * in forgetUser). Before those rows disappear, storage refs enter the
   * durable evidence_blob_gc outbox (0114). Blobs go AFTER the rows (an
   * aborted cascade must not leave rows pointing at deleted bytes): an
   * immediate failure remains queued for the nightly reconciliation pass.
   */
  private async eraseEvidenceRows(
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> },
    companyId: string,
    userId: string,
  ): Promise<{
    evidenceAssetsDeleted: number;
    evidenceFragmentsDeleted: number;
    representationsDeleted: number;
  }> {
    const [refRows] = await db.query<[unknown[]]>(
      `SELECT VALUE storageRef FROM evidence_asset
        WHERE userId = $u AND storageRef != NONE`,
      { u: userId },
    );
    const storageRefs = [...new Set(((refRows as unknown[]) ?? []).map(String))];
    if (storageRefs.length > 0) {
      await db.query(`INSERT INTO evidence_blob_gc $rows`, {
        rows: storageRefs.map((storageRef) => ({ storageRef, reason: 'user_forget' })),
      });
    }
    // Processing runs (0121) key off assetId only — no ordering hazard
    // with the repr/frag legs; reprs-before-frags stays exactly as is.
    const [, , , , , reprsGone, fragsGone, assetsGone] = await db.query<
      [unknown, unknown, unknown, unknown, unknown[], unknown[], unknown[], unknown[]]
    >(
      `LET $assetIds = (SELECT VALUE id FROM evidence_asset WHERE userId = $u);
       LET $fragIds = (SELECT VALUE id FROM evidence_fragment WHERE assetId INSIDE $assetIds);
       LET $reprIds = (SELECT VALUE id FROM derived_representation
         WHERE subjectId INSIDE $assetIds OR subjectId INSIDE $fragIds);
       LET $runIds = (SELECT VALUE id FROM processing_run WHERE assetId INSIDE $assetIds);
       DELETE $runIds RETURN BEFORE;
       DELETE $reprIds RETURN BEFORE;
       DELETE $fragIds RETURN BEFORE;
       DELETE $assetIds RETURN BEFORE;`,
      { u: userId },
    );
    let blobFailures = 0;
    for (const ref of storageRefs) {
      const ok = (await this.evidence?.deleteBlobBestEffort(ref)) ?? false;
      if (!ok) {
        blobFailures++;
        continue;
      }
      const [gcIds] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM evidence_blob_gc WHERE storageRef = $ref`,
        { ref },
      );
      if (((gcIds as unknown[]) ?? []).length > 0) {
        await db.query(`DELETE $ids`, { ids: gcIds });
      }
    }
    if (blobFailures > 0) {
      this.logger.error(
        `user forget ${companyId}/${userId}: ${blobFailures}/${storageRefs.length} evidence blob delete(s) failed — queued for durable retry`,
      );
    }
    return {
      evidenceAssetsDeleted: ((assetsGone as unknown[]) ?? []).length,
      evidenceFragmentsDeleted: ((fragsGone as unknown[]) ?? []).length,
      representationsDeleted: ((reprsGone as unknown[]) ?? []).length,
    };
  }
}
