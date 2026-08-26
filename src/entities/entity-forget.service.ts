import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import { SurrealService, runTransaction, queryRows, queryFirst } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { normalizeEntityId } from './entity-read.helpers';
import { ForgetOptions, ForgetResult } from './entities.service';

/** A previously-written tombstone, read back for idempotent-replay. */
interface ForgottenTombstoneRow {
  entityIdHash: string;
  factsDeleted?: number;
  edgesDeleted?: number;
  auditEventsDeleted?: number;
  episodesDeleted?: number;
  segmentsDeleted?: number;
  forgottenAt: string | Date;
}

/** Shape returned by the atomic-erase transaction's trailing RETURN. */
interface ForgetTxResult {
  auditEventsDeleted: number;
  episodesDeleted: number;
  segmentsDeleted: number;
  tombstone: { id: unknown; entityIdHash: string } | null;
}

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
 *
 * Atomicity (R4 audit): the erase runs inside ONE client-managed
 * SurrealDB transaction (`runTransaction`, the confirmed BEGIN/COMMIT
 * idiom — separate `query('BEGIN')`/`query('COMMIT')` calls do NOT work
 * on the pinned driver, each is its own scope). Every mutation — subject
 * rows, derived rows, L0 turns, the audit-mirror scrub, and the
 * `forgotten_entity` tombstone — commits together or not at all. A
 * mid-sequence failure rolls back completely, so a retry (keyed on
 * `requestId`) either finds the finished tombstone and no-ops, or re-runs
 * the whole erase from a clean slate. Never a partially-erased subject.
 *
 * Structural REFERENCE ON DELETE CASCADE/UNSET (SurrealDB record
 * references) for the derived deps is a documented follow-up — it needs a
 * schema migration and is intentionally out of scope here.
 */
@Injectable()
export class EntityForgetService {
  private readonly logger = new Logger(EntityForgetService.name);
  private readonly forgetHmacKey: string;
  /**
   * Transaction-size cap. The atomic erase is a single transaction; an
   * entity with pathological fan-out (tens of thousands of facts + their
   * mirrored audit rows) would build an oversized transaction that risks
   * the server's write-key / transaction limit. We BOUND rather than
   * chunk: chunk-with-resume would need durable per-chunk progress state
   * (a schema change, forbidden here) and would reintroduce the very
   * partial-erase window this fix closes. When the fan-out exceeds the
   * cap we fail fast BEFORE any mutation (nothing partially erased) and
   * the operator uses whole-tenant offboarding (dropCompanyDatabase),
   * raises the cap deliberately, or waits for the resumable-chunked
   * follow-up. Configurable via FORGET_MAX_TX_RECORDS.
   */
  private readonly maxTxRecords: number;

  constructor(
    private readonly surreal: SurrealService,
    private readonly configService: ConfigService,
    @Optional() private readonly embedder?: EmbedderService,
  ) {
    // Used to hash forgotten entity ids in the tombstone. If unset, derive
    // a per-process default — safe enough for 0.1.0 walking skeleton, but
    // production deployments MUST set this so tombstones survive restart.
    this.forgetHmacKey = this.configService.get<string>('FORGET_HMAC_KEY') ?? 'inite-brain-default';
    const cap = parseInt(this.configService.get<string>('FORGET_MAX_TX_RECORDS', '10000'), 10);
    this.maxTxRecords = Number.isFinite(cap) && cap >= 1 ? cap : 10000;
  }

  async forget({
    companyId,
    entityIdRaw,
    dto,
    actorKeyHash,
  }: ForgetOptions): Promise<ForgetResult> {
    const ref = normalizeEntityId(entityIdRaw);
    // Deterministic over (companyId, ref.full): a retry of the same request
    // recomputes the identical hash, which — paired with requestId — is how
    // an idempotent replay is detected below.
    const entityIdHash =
      'hmac:' +
      createHmac('sha256', this.forgetHmacKey).update(`${companyId}/${ref.full}`).digest('hex');

    const result = await this.surreal.withCompany(companyId, async (db) => {
      // ── Idempotent retry (R4). The whole erase is atomic, so a failed or
      // partial attempt left NO tombstone — only a fully-committed erase is
      // visible here. A tombstone matching BOTH this requestId AND this
      // entity hash is a true replay: return the stored result, never
      // re-erase, never double-error. Matching on the pair (not requestId
      // alone) means a requestId accidentally reused across DIFFERENT
      // entities still erases each one.
      const prior = await queryFirst<ForgottenTombstoneRow>(
        db,
        `SELECT entityIdHash, factsDeleted, edgesDeleted, auditEventsDeleted,
                episodesDeleted, segmentsDeleted, forgottenAt
           FROM forgotten_entity
          WHERE requestId = $requestId AND entityIdHash = $hash
          LIMIT 1`,
        { requestId: dto.requestId, hash: entityIdHash },
      );
      if (prior) {
        this.logger.warn(
          `[knowledge.entity.forgotten] idempotent replay companyId=${companyId} ` +
            `hash=${entityIdHash} requestId=${dto.requestId} — returning stored result`,
        );
        return {
          entityIdHash: prior.entityIdHash,
          factsDeleted: prior.factsDeleted ?? 0,
          edgesDeleted: prior.edgesDeleted ?? 0,
          auditEventsDeleted: prior.auditEventsDeleted ?? 0,
          episodesDeleted: prior.episodesDeleted ?? 0,
          segmentsDeleted: prior.segmentsDeleted ?? 0,
          forgottenAt: new Date(prior.forgottenAt).toISOString(),
        } satisfies ForgetResult;
      }

      // Verify exists. After a committed erase the entity is gone AND the
      // idempotency check above already returned; so reaching here with a
      // missing entity means it never existed (or was erased under a
      // different requestId) → 404.
      const entity = await queryFirst<{ id: unknown }>(
        db,
        `SELECT id FROM type::record('knowledge_entity', $rid) LIMIT 1`,
        { rid: ref.id },
      );
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
      const factIdRows = await queryRows<{ id: unknown }>(
        db,
        `SELECT id FROM knowledge_fact
         WHERE entityId = type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      const edgeIdRows = await queryRows<{ id: unknown }>(
        db,
        `SELECT id FROM knowledge_edge
         WHERE in = type::record('knowledge_entity', $rid) OR out = type::record('knowledge_entity', $rid)`,
        { rid: ref.id },
      );
      const factIds = factIdRows.map((r) => String(r.id));
      const edgeIds = edgeIdRows.map((r) => String(r.id));
      const factsDeleted = factIds.length;
      const edgesDeleted = edgeIds.length;

      // L0 grounding turns (audit W1, finding #13). Erasure used to stop at
      // L1: the verbatim episodes naming the subject stayed readable through
      // the episodic/segment lanes and GET /v1/episodes, AND a re-derive
      // resurrected the deleted facts from them. Resolve the grounding
      // episodes BEFORE the facts go — source.episodeIds is the only link.
      //
      // A turn that grounds facts of several subjects is deleted whole: the
      // other subjects keep their derived facts (separate rows), they lose
      // only the raw turn. Erasure wins over retention.
      const groundingRows = await queryRows<{ eps: unknown }>(
        db,
        `SELECT source.episodeIds AS eps FROM knowledge_fact
         WHERE entityId = type::record('knowledge_entity', $rid)
           AND source.episodeIds IS NOT NONE`,
        { rid: ref.id },
      );
      const episodeIds = [
        ...new Set(
          groundingRows.flatMap((r) =>
            Array.isArray(r.eps) ? r.eps.map((e: unknown) => String(e)) : [],
          ),
        ),
      ].filter((id) => id.startsWith('episode:'));
      const episodeRefs = episodeIds.map((id) => new StringRecordId(id));
      const recordIds = [entityIdStr, ...factIds, ...edgeIds];

      // Side-table rows to erase BY EXPLICIT ID — see the
      // preCollectSideTableIds docblock for the 3.2.4 planner contract.
      const { feedbackIds, artifactIds } = await this.preCollectSideTableIds(db, ref.id);

      // ── Transaction-size guard — see the guardTxRecordCap docblock.
      await this.guardTxRecordCap(db, {
        recordIds,
        episodeRefs,
        fixedCount:
          factsDeleted + edgesDeleted + episodeIds.length + feedbackIds.length + artifactIds.length,
      });

      // ── 0107 outcome telemetry: bulk-purge the raw event log OUTSIDE
      // the atomic erase (see preSweepOutcomeRows — content-free by
      // contract, deliberately uncounted in txRecordCount like
      // fact_usage, so FORGET_MAX_TX_RECORDS never trips on telemetry).
      await this.preSweepOutcomeRows(db, ref.id);

      // ── Atomic erase. Everything below commits together or rolls back
      // together (single BEGIN/COMMIT). Ordering inside the transaction is
      // for readability only — the commit is atomic — but we keep the
      // dependency order (segments before the episodes they quote; derived
      // rows before the facts; audit mirror scrubbed by the pre-collected
      // record-id list; tombstone last).
      const forgottenAt = new Date();
      const txResult = await runTransaction<ForgetTxResult>(db, (tx) => {
        tx.bind('rid', ref.id)
          .bind('eps', episodeRefs)
          .bind('recordIds', recordIds)
          .bind('cid', companyId)
          .bind('needle', entityIdStr)
          .bind('entityIdHash', entityIdHash)
          .bind('reason', dto.reason)
          .bind('requestId', dto.requestId)
          .bind('factsDeleted', factsDeleted)
          .bind('edgesDeleted', edgesDeleted)
          .bind('forgottenBy', actorKeyHash ?? 'unknown')
          .bind('forgottenAt', forgottenAt)
          .bind('feedbackIds', feedbackIds)
          .bind('artifactIds', artifactIds);
        tx.add(`LET $ent = type::record('knowledge_entity', $rid)`);
        // fact_usage (0053) + retrieval_feedback (0054) are keyed by fact
        // record — the traversal dies with the facts, so purge first.
        // fact_usage stays one-step: its factId carries a single-field
        // UNIQUE index, the verified-working shape on the pinned server.
        // retrieval_feedback goes BY THE PRE-COLLECTED IDS — its
        // traversal DELETE is the 3.2.4 planner no-op (see the
        // pre-collect comment above).
        tx.add(`DELETE fact_usage WHERE factId.entityId = $ent`);
        tx.add(`DELETE $feedbackIds`);
        // Scenes (0106): a scene whose membership quotes an erased episode
        // goes whole, with ALL its member rows (mixed-subject scenes lose
        // the scene, other subjects keep their own facts) — members before
        // scenes, scenes before the episodes they quote. NOTE: surviving
        // facts may keep stale source.memoryEpisodeIds strings after this,
        // the same class as stale source.episodeIds — repaired by the PR2
        // backlink re-run, not chased here.
        //
        // Two-step (SELECT ids → DELETE $ids) DELIBERATELY: on SurrealDB
        // 3.2.4 a DELETE whose WHERE filters on `in` — covered only by
        // the COMPOUND scene_member_uq index — silently matches NOTHING
        // (even a direct `in INSIDE $ids` form; a traversal through it
        // fails the same way), while the same WHERE in a SELECT matches
        // fine — verified against the pinned server. Deleting by explicit
        // ids sidesteps the planner entirely. Same bug class as
        // preSweepOutcomeRows (PR #372).
        tx.add(
          `LET $sceneIds = (SELECT VALUE in FROM memory_episode_member WHERE out INSIDE $eps)`,
        );
        tx.add(
          `LET $sceneMemberIds = (SELECT VALUE id FROM memory_episode_member WHERE in INSIDE $sceneIds)`,
        );
        tx.add(`DELETE $sceneMemberIds`);
        tx.add(`LET $scenesDel = (DELETE memory_episode WHERE id INSIDE $sceneIds RETURN BEFORE)`);
        // 0107 outcome telemetry: stragglers written after the pre-tx
        // bulk sweep, plus the one-row-per-subject rollup (small enough
        // to live inside the tx). Uncounted in txRecordCount, like
        // fact_usage. LET-then-DELETE-by-ids, NOT `DELETE … WHERE`
        // (the 3.2.4 indexed-traversal DELETE bug — see the pre-tx sweep
        // comment above).
        tx.add(
          `LET $outIds = (SELECT VALUE id FROM memory_outcome WHERE subjectId.entityId = $ent)`,
        );
        tx.add(`DELETE $outIds`);
        tx.add(
          `LET $outStatIds = (SELECT VALUE id FROM memory_outcome_stat WHERE subjectId.entityId = $ent)`,
        );
        tx.add(`DELETE $outStatIds`);
        // L0: a segment that quotes an erased episode goes with it; segments
        // before episodes to keep the dependency order.
        tx.add(
          `LET $segs = (DELETE episode_segment WHERE episodeIds CONTAINSANY $eps RETURN BEFORE)`,
        );
        tx.add(`LET $epsDel = (DELETE episode WHERE id INSIDE $eps RETURN BEFORE)`);
        // Cascade hard-delete. Embedding columns die with the rows.
        tx.add(`DELETE knowledge_fact WHERE entityId = $ent`);
        tx.add(`DELETE knowledge_edge WHERE in = $ent OR out = $ent`);
        tx.add(`DELETE type::record('knowledge_entity', $rid)`);
        // Purge the materialised audit_event mirror for every deleted record
        // (entity + its facts + edges). recordId IN [...] matches how the
        // consumer wrote them. (Race note: a still-unconsumed changefeed
        // tick can re-materialise a row after this — the structural defence
        // is consumer-side PII redaction of `after`; this scrubs the rows
        // already materialised.)
        tx.add(`LET $audit = (DELETE audit_event WHERE recordId IN $recordIds RETURN BEFORE)`);
        // dream_emit: subject/object hold the entity/fact ids the dreams
        // resolver linked or superseded (carries fact-derived `detail`).
        tx.add(`DELETE dream_emit WHERE subject IN $recordIds OR object IN $recordIds`);
        // debug_trace: per-request blobs can carry the subject's raw fact
        // text / queries when DEBUG_TRACE_PERSIST is on. Not entity-keyed —
        // drop this tenant's traces whose serialised artifacts reference it.
        tx.add(
          `DELETE debug_trace WHERE companyId = $cid AND string::contains(<string>artifacts, $needle)`,
        );
        // knowledge_artifact: compiled per-entity dossiers carry
        // name/contact/complaints — entityId-keyed, erased by the
        // pre-collected ids (compound-only index coverage — the risky
        // 3.2.4 planner shape, see the pre-collect comment above).
        tx.add(`DELETE $artifactIds`);
        // ingest_dead_letter: rejected facts keep payload.{object,entityId}.
        tx.add(`DELETE ingest_dead_letter WHERE payload.entityId = $ent`);
        // entity_external_ref: external subject identifier + pointer.
        tx.add(`DELETE entity_external_ref WHERE entity = $ent`);
        // evidence_asset / evidence_fragment / derived_representation
        // (0109) are DELIBERATELY NOT deleted here: an asset is a
        // user/tenant-scoped OBSERVATION, not an entity-scoped claim —
        // erasing a subject entity removes what the brain BELIEVES about
        // it, while the tenant's original observation may ground other
        // subjects. Assets die with their user (user-forget cascade),
        // their retainUntil (sweeper), or their tenant (offboarding).
        // See the 0109 migration header.
        // Tombstone — GDPR accountability (Art. 5(2)/30): record WHO
        // performed the erasure (hashed credential) + requestId so a repeat
        // is detectable. factsDeleted/edgesDeleted are the pre-collected
        // counts; the L0 + audit counts come from the RETURN BEFORE lengths.
        tx.add(`LET $tomb = (CREATE forgotten_entity CONTENT {
            entityIdHash: $entityIdHash,
            reason: $reason,
            requestId: $requestId,
            factsDeleted: $factsDeleted,
            edgesDeleted: $edgesDeleted,
            auditEventsDeleted: array::len($audit),
            episodesDeleted: array::len($epsDel),
            segmentsDeleted: array::len($segs),
            scenesDeleted: array::len($scenesDel),
            forgottenBy: $forgottenBy,
            forgottenAt: $forgottenAt
          } RETURN AFTER)`);
        tx.add(`RETURN {
            auditEventsDeleted: array::len($audit),
            episodesDeleted: array::len($epsDel),
            segmentsDeleted: array::len($segs),
            tombstone: $tomb[0]
          }`);
      });

      // A committed erase always returns its tombstone; its absence means
      // the transaction didn't land — fail loud rather than report success.
      if (!txResult?.tombstone) {
        throw new Error('entity forget: transaction returned no tombstone row');
      }
      const auditEventsDeleted = txResult.auditEventsDeleted ?? 0;
      const episodesDeleted = txResult.episodesDeleted ?? 0;
      const segmentsDeleted = txResult.segmentsDeleted ?? 0;

      this.logger.warn(
        `[knowledge.entity.forgotten] companyId=${companyId} hash=${entityIdHash} ` +
          `factsDeleted=${factsDeleted} edgesDeleted=${edgesDeleted} ` +
          `auditEventsDeleted=${auditEventsDeleted} ` +
          `episodesDeleted=${episodesDeleted} segmentsDeleted=${segmentsDeleted} ` +
          `reason=${dto.reason} requestId=${dto.requestId} ` +
          `by=${actorKeyHash ?? 'unknown'}`,
      );

      return {
        entityIdHash,
        factsDeleted,
        edgesDeleted,
        auditEventsDeleted,
        episodesDeleted,
        segmentsDeleted,
        forgottenAt: forgottenAt.toISOString(),
      } satisfies ForgetResult;
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
      this.logger.warn(`embedder cache eviction after forget failed: ${(e as Error).message}`);
    }

    return result;
  }

  /**
   * L0 fan-out of the erase for the transaction-size guard: segments that
   * quote the dying episodes (audit W1 #13) PLUS — scenes, 0106 — the
   * membership rows of those episodes and the distinct scene rows they
   * resolve to. All of these join the same single transaction, so they
   * count toward FORGET_MAX_TX_RECORDS BEFORE any mutation.
   */
  private async countL0FanOut(
    db: Parameters<Parameters<SurrealService['withCompany']>[1]>[0],
    episodeRefs: StringRecordId[],
  ): Promise<number> {
    if (episodeRefs.length === 0) return 0;
    const segCountRow = await queryFirst<{ count: number }>(
      db,
      `SELECT count() FROM episode_segment WHERE episodeIds CONTAINSANY $eps GROUP ALL`,
      { eps: episodeRefs },
    );
    const sceneMemberCountRow = await queryFirst<{ count: number }>(
      db,
      `SELECT count() FROM memory_episode_member WHERE out INSIDE $eps GROUP ALL`,
      { eps: episodeRefs },
    );
    const sceneIdRows = await queryRows<{ in: unknown }>(
      db,
      `SELECT in FROM memory_episode_member WHERE out INSIDE $eps`,
      { eps: episodeRefs },
    );
    const sceneCount = new Set(sceneIdRows.map((r) => String(r.in))).size;
    return (segCountRow?.count ?? 0) + (sceneMemberCountRow?.count ?? 0) + sceneCount;
  }

  /**
   * 0107 outcome telemetry pre-sweep: bulk-purge the subject's raw
   * memory_outcome rows OUTSIDE the atomic erase, in bounded batches, so
   * a telemetry-heavy subject can't inflate the erase transaction. Safe
   * outside the tx because meta is CONTENT-FREE by contract (ids /
   * verdict strings only, never fact text): an erase that aborts after
   * this merely deleted telemetry early. The in-tx DELETEs catch
   * stragglers written between this sweep and the commit.
   *
   * Two-step (SELECT ids → DELETE $ids) DELIBERATELY: on SurrealDB 3.2.4
   * a DELETE whose WHERE traverses through an indexed record field
   * (memory_outcome_subject_idx covers subjectId) silently matches
   * NOTHING, while the same WHERE in a SELECT matches fine — verified
   * against the pinned server. Deleting by explicit ids sidesteps the
   * planner entirely.
   */
  private async preSweepOutcomeRows(
    db: { query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T> },
    rid: string,
  ): Promise<void> {
    for (;;) {
      const [, batch] = await db.query<[unknown, unknown[]]>(
        `LET $ids = (SELECT VALUE id FROM memory_outcome
           WHERE subjectId.entityId = type::record('knowledge_entity', $rid)
           LIMIT 5000);
         DELETE $ids RETURN BEFORE`,
        { rid },
      );
      // A partial batch means the subject's raw rows are drained.
      if (((batch as unknown[]) ?? []).length < 5000) break;
    }
  }

  /**
   * Side-table rows the erase transaction must delete BY EXPLICIT ID
   * (same pre-collect contract as recordIds): on SurrealDB 3.2.4 a
   * DELETE whose WHERE traverses through factId — covered by the
   * COMPOUND (factId, actor) UNIQUE index — silently matches NOTHING
   * (returns OK, deletes zero rows) while the same WHERE in a SELECT
   * matches fine — reproduced 12/12 against the pinned server. Deleting
   * by explicit ids sidesteps the planner entirely. Same bug class as
   * preSweepOutcomeRows (PR #372) / scene membership (PR #370).
   * knowledge_artifact.entityId is covered ONLY by the COMPOUND
   * (entityId, artifactType) UNIQUE index — same risky shape, hardened
   * defensively. Collected OUTSIDE the transaction (like every other id
   * set) so the tx read-set does not grow side-table scans; both tables
   * are keyed by rows the transaction deletes, so nothing can recreate
   * them post-commit. Both counts feed the transaction-size guard.
   */
  private async preCollectSideTableIds(
    db: Parameters<Parameters<SurrealService['withCompany']>[1]>[0],
    rid: string,
  ): Promise<{ feedbackIds: unknown[]; artifactIds: unknown[] }> {
    const [feedbackIdRows] = await db.query<[unknown[]]>(
      `SELECT VALUE id FROM retrieval_feedback WHERE factId.entityId = type::record('knowledge_entity', $rid)`,
      { rid },
    );
    const [artifactIdRows] = await db.query<[unknown[]]>(
      `SELECT VALUE id FROM knowledge_artifact WHERE entityId = type::record('knowledge_entity', $rid)`,
      { rid },
    );
    return {
      feedbackIds: (feedbackIdRows as unknown[]) ?? [],
      artifactIds: (artifactIdRows as unknown[]) ?? [],
    };
  }

  /**
   * Transaction-size guard. Count the two open-ended tables (audit
   * mirror rows grow with every mutation; L0 fan-out with every turn) on
   * top of the caller's pre-collected fixed counts so the cap reflects
   * the real transaction footprint, then refuse an oversized single
   * transaction BEFORE anything mutates (nothing partially erased —
   * see the maxTxRecords docblock for the bound-don't-chunk rationale).
   */
  private async guardTxRecordCap(
    db: Parameters<Parameters<SurrealService['withCompany']>[1]>[0],
    counts: { recordIds: string[]; episodeRefs: StringRecordId[]; fixedCount: number },
  ): Promise<void> {
    const auditCountRow = await queryFirst<{ count: number }>(
      db,
      `SELECT count() FROM audit_event WHERE recordId IN $ids GROUP ALL`,
      { ids: counts.recordIds },
    );
    const auditCount = auditCountRow?.count ?? 0;
    const l0FanOut = await this.countL0FanOut(db, counts.episodeRefs);
    const txRecordCount = counts.fixedCount + l0FanOut + auditCount;
    if (txRecordCount > this.maxTxRecords) {
      throw new PayloadTooLargeException(
        `Entity forget fan-out (${txRecordCount} records) exceeds ` +
          `FORGET_MAX_TX_RECORDS (${this.maxTxRecords}); refusing to build an ` +
          `oversized single transaction. Use whole-tenant offboarding ` +
          `(drop database), raise the cap deliberately, or use the ` +
          `resumable-chunked erase follow-up.`,
      );
    }
  }
}
