import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { SurrealService, dbCreate } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { normalizeEntityId } from './entity-read.helpers';
import { ForgetOptions, ForgetResult } from './entities.service';

/**
 * EntityForgetService — the GDPR erasure path.
 *
 * Owns the full "forget an entity" responsibility: cascade hard-delete of
 * the entity + its facts/edges, purge of every PII-bearing mirror
 * (audit_event, dream_emit, debug_trace, knowledge_artifact,
 * ingest_dead_letter, entity_external_ref), the HMAC-hashed tombstone,
 * and the post-erasure embedder-cache eviction. Split out of
 * EntitiesService so the read path (surreal only) and the erasure path
 * (surreal + hmac config + embedder cache) each keep ≤3 injected deps.
 */
@Injectable()
export class EntityForgetService {
  private readonly logger = new Logger(EntityForgetService.name);
  private readonly forgetHmacKey: string;

  constructor(
    private readonly surreal: SurrealService,
    private readonly configService: ConfigService,
    @Optional() private readonly embedder?: EmbedderService,
  ) {
    // Used to hash forgotten entity ids in the tombstone. If unset, derive
    // a per-process default — safe enough for 0.1.0 walking skeleton, but
    // production deployments MUST set this so tombstones survive restart.
    this.forgetHmacKey =
      this.configService.get<string>('FORGET_HMAC_KEY') ?? 'inite-brain-default';
  }

  async forget({
    companyId,
    entityIdRaw,
    dto,
    actorKeyHash,
  }: ForgetOptions): Promise<ForgetResult> {
    const ref = normalizeEntityId(entityIdRaw);

    const result = await this.surreal.withCompany(companyId, async (db) => {
      // Verify exists
      const [entRows] = await db.query<any[][]>(
        `SELECT id FROM type::record('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      const entity = (entRows as any[])?.[0];
      if (!entity) {
        throw new NotFoundException(`Entity ${entityIdRaw} not found`);
      }
      // Use the DB's own stringification of the id (not string-concat of
      // ref.full) so it matches exactly how the changefeed consumer wrote
      // recordId, regardless of any escaping for non-alphanumeric ids.
      const entityIdStr = String(entity.id);

      // Collect the exact record ids that will be deleted BEFORE deleting
      // them. The changefeed consumer mirrors every knowledge_* mutation
      // into audit_event keyed by `recordId` (the record's `id.toString()`
      // — full `table:id` form), and create/update rows carry the full
      // post-image in `audit_event.after`, including PII fact `object`
      // values. Without this, a GDPR-erased subject stayed fully
      // reconstructable from audit_event indefinitely.
      const [factIdRows] = await db.query<any[][]>(
        `SELECT id FROM knowledge_fact
         WHERE entityId = type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      const [edgeIdRows] = await db.query<any[][]>(
        `SELECT id FROM knowledge_edge
         WHERE in = type::record('knowledge_entity', $rid) OR out = type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      const factIds = ((factIdRows as any[]) ?? []).map((r) => String(r.id));
      const edgeIds = ((edgeIdRows as any[]) ?? []).map((r) => String(r.id));
      const factsDeleted = factIds.length;
      const edgesDeleted = edgeIds.length;

      // Cascade hard-delete. Embedding columns die with the rows.
      await db.query(
        `DELETE knowledge_fact
         WHERE entityId = type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      await db.query(
        `DELETE knowledge_edge
         WHERE in = type::record('knowledge_entity', $rid) OR out = type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      await db.query(
        `DELETE type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );

      // Purge the materialised audit_event mirror for every deleted
      // record (entity + its facts + edges). recordId IN [...] matches
      // exactly how the consumer wrote them.
      //
      // Race note: the changefeed consumer is a lagging cron. If a
      // CREATE/UPDATE for one of these records is still unconsumed in the
      // rocksdb CHANGEFEED at forget time, a later tick re-materialises it
      // into audit_event. The structural defence is consumer-side
      // redaction of PII value fields in `after` (see
      // changefeed-consumer redactAfterImage) so re-mirrored rows carry
      // no raw PII; this purge removes the already-materialised rows.
      const recordIds = [entityIdStr, ...factIds, ...edgeIds];
      const [auditDeleted] = await db.query<any[][]>(
        `DELETE audit_event WHERE recordId IN $ids RETURN BEFORE`,
        { ids: recordIds },
      );
      const auditEventsDeleted = ((auditDeleted as any[]) ?? []).length;

      // dream_emit: subject/object hold the entity/fact ids the dreams
      // resolver linked or superseded — purge any referencing the
      // forgotten records (carries fact-derived `detail`).
      await db.query(
        `DELETE dream_emit WHERE subject IN $ids OR object IN $ids`,
        { ids: recordIds },
      );

      // debug_trace: per-request blobs (artifacts) can carry the subject's
      // raw fact text / queries when DEBUG_TRACE_PERSIST is on. Not
      // entity-keyed, so best-effort: drop this tenant's traces whose
      // serialised artifacts reference the entity or any deleted fact id.
      await db.query(
        `DELETE debug_trace
           WHERE companyId = $cid
             AND string::contains(<string>artifacts, $needle)`,
        { cid: companyId, needle: entityIdStr },
      );

      // knowledge_artifact: compiled per-entity dossiers (customer_profile,
      // support_context) carry name/contact/complaints — entityId-keyed.
      await db.query(
        `DELETE knowledge_artifact
           WHERE entityId = type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );

      // ingest_dead_letter: rejected facts keep payload.{object,entityId}.
      await db.query(
        `DELETE ingest_dead_letter
           WHERE payload.entityId = type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );

      // entity_external_ref: external subject identifier + pointer.
      await db.query(
        `DELETE entity_external_ref
           WHERE entity = type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );

      const entityIdHash =
        'hmac:' +
        createHmac('sha256', this.forgetHmacKey)
          .update(`${companyId}/${ref.full}`)
          .digest('hex');

      const forgottenAt = new Date();
      await dbCreate(db, 'forgotten_entity', {
        entityIdHash,
        reason: dto.reason,
        requestId: dto.requestId,
        factsDeleted,
        edgesDeleted,
        auditEventsDeleted,
        // GDPR accountability (Art. 5(2)/30): record WHO performed the
        // erasure (hashed admin credential), not just that it happened.
        forgottenBy: actorKeyHash ?? 'unknown',
        forgottenAt,
      });

      this.logger.warn(
        `[knowledge.entity.forgotten] companyId=${companyId} hash=${entityIdHash} ` +
        `factsDeleted=${factsDeleted} edgesDeleted=${edgesDeleted} ` +
        `auditEventsDeleted=${auditEventsDeleted} reason=${dto.reason} ` +
        `by=${actorKeyHash ?? 'unknown'}`,
      );

      return {
        entityIdHash,
        factsDeleted,
        edgesDeleted,
        auditEventsDeleted,
        forgottenAt: forgottenAt.toISOString(),
      };
    });

    // Best-effort: drop the in-process embedder cache so the forgotten
    // subject's PII text (used as a cache key → vector) no longer lingers
    // in memory. Process-local + capacity-bounded, but a GDPR erasure
    // should not leave the identifying text resident. Cross-tenant
    // collateral is acceptable given how rare forget is.
    try {
      const evicted = this.embedder?.evictAll() ?? 0;
      if (evicted > 0) {
        this.logger.warn(
          `[knowledge.entity.forgotten] embedder cache cleared (${evicted} entries) after erasure`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `embedder cache eviction after forget failed: ${(e as Error).message}`,
      );
    }

    return result;
  }
}
