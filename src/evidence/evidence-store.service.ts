import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  isUniqueViolation,
  queryFirst,
  queryRows,
} from '../db/surreal.service';
import {
  evidenceMaxBytes,
  evidenceQuarantineEnabled,
  evidenceSubstrateEnabled,
} from '../common/evidence-flags';
import {
  DERIVED_REPRESENTATION_KINDS,
  EVIDENCE_MODALITIES,
  type DerivedRepresentationKind,
  type EvidenceModality,
} from '../common/evidence-taxonomy';
import { idTailOf, redactPiiWithReport } from '../ingest/ingest-utils';
import { validateLocator } from './locator';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  EvidenceStorageRegistry,
  storageRefScheme,
} from './storage/storage-adapter';

const HASH_RE = /^[0-9a-f]{64}$/;
// IANA media-type shape (type "/" subtype over the registered-name
// charset) — open vocabulary, shape-only (0048 `kind` doctrine).
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const LABEL_MAX = 200;
const MODALITIES = new Set<string>(EVIDENCE_MODALITIES);
const REPR_KINDS = new Set<string>(DERIVED_REPRESENTATION_KINDS);

export type { DerivedRepresentationKind, EvidenceModality } from '../common/evidence-taxonomy';

export interface RegisterAssetInput {
  modality: EvidenceModality;
  mediaType: string;
  byteHash: string;
  byteLength: number;
  occurredAt: Date;
  storageRef?: string | undefined;
  originUri?: string | undefined;
  userId?: string | undefined;
  scope?: string[] | undefined;
  piiClasses?: string[] | undefined;
  vertical: string;
  recorder?: string | undefined;
  retainUntil?: Date | undefined;
  meta?: Record<string, unknown> | undefined;
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  pageCount?: number | undefined;
  /** Where the bytes came from (0121 MM-6). Default 'internal'.
   *  'external_ingest' REQUIRES EVIDENCE_QUARANTINE (503 otherwise —
   *  fail closed: no external bytes may enter without the seam). */
  origin?: 'internal' | 'external_ingest' | undefined;
}

export interface AddFragmentInput {
  assetId: string;
  locator: Record<string, unknown>;
  label?: string | undefined;
  piiClasses?: string[] | undefined;
}

export interface AddRepresentationInput {
  subjectId: string;
  subjectKind: 'asset' | 'fragment';
  kind: DerivedRepresentationKind;
  content?: string | undefined;
  model?: string | undefined;
  modelVersion?: string | undefined;
  promptVersion?: string | undefined;
  confidence?: number | undefined;
  lang?: string | undefined;
  producerVersion: string;
  /** Lineage back to the processing_run that produced this row (0121). */
  producedByRun?: string | undefined;
}

/**
 * EvidenceStoreService — the ONE write seam of the evidence substrate
 * (0109): registerAsset / addFragment / addRepresentation plus the GDPR
 * blob hook and the retention/reconciliation sweep legs. NO HTTP
 * controller in this PR — the ingest surface is the sibling PR-C; tests
 * and future PRs call the service directly.
 *
 * Every WRITER is gated on EVIDENCE_SUBSTRATE_ENABLED (503 when off — no
 * row is ever written). The delete-side legs (deleteBlobBestEffort,
 * sweepTenantEvidence) deliberately run REGARDLESS of the flag: rows and
 * blobs written while it was on must stay erasable after it is off.
 */
@Injectable()
export class EvidenceStoreService {
  private readonly logger = new Logger(EvidenceStoreService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Inject(EVIDENCE_STORAGE_ADAPTERS)
    private readonly adapters: EvidenceStorageRegistry,
  ) {}

  private gate(): void {
    if (!evidenceSubstrateEnabled()) {
      throw new ServiceUnavailableException('EVIDENCE_SUBSTRATE_ENABLED is off');
    }
  }

  /**
   * Register one asset. Idempotent over byteHash (UNIQUE): same-user
   * re-registration returns the existing id with `deduped: true`.
   * A DIFFERENT user hitting an existing hash gets a bare 409 WITHOUT the
   * stored row's metadata — otherwise registering probe hashes would leak
   * whether (and as what) another principal already holds those bytes
   * (the dedup-probe leak, closed here on purpose).
   */
  async registerAsset(
    companyId: string,
    input: RegisterAssetInput,
  ): Promise<{ assetId: string; availability: string; deduped: boolean }> {
    this.gate();
    this.validateAssetShape(input);
    const quarantineStatus = this.quarantineStampFor(input.origin);
    const availability = await this.deriveAvailability(companyId, input);
    return this.surreal.withCompany(companyId, async (db) => {
      try {
        const row = await dbCreate<Record<string, unknown>>(db, 'evidence_asset', {
          modality: input.modality,
          mediaType: input.mediaType,
          byteHash: input.byteHash,
          byteLength: input.byteLength,
          width: input.width,
          height: input.height,
          durationMs: input.durationMs,
          pageCount: input.pageCount,
          occurredAt: input.occurredAt,
          storageRef: input.storageRef,
          originUri: input.originUri,
          availability,
          userId: input.userId,
          scope: input.scope ?? [],
          piiClasses: input.piiClasses,
          vertical: input.vertical,
          recorder: input.recorder,
          retainUntil: input.retainUntil,
          meta: input.meta,
          // Key OMITTED (not undefined-valued) when the seam is off —
          // the off-state row must be byte-identical (0121).
          ...(quarantineStatus !== undefined ? { quarantineStatus } : {}),
        });
        return { assetId: String(row.id), availability, deduped: false };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const existing = await queryFirst<{ id: unknown; userId?: string; availability: string }>(
          db,
          `SELECT id, userId, availability FROM evidence_asset WHERE byteHash = $h LIMIT 1`,
          { h: input.byteHash },
        );
        if (!existing) throw err;
        if ((existing.userId ?? undefined) !== (input.userId ?? undefined)) {
          throw new ConflictException('evidence asset with this byteHash already registered');
        }
        return {
          assetId: String(existing.id),
          availability: String(existing.availability),
          deduped: true,
        };
      }
    });
  }

  /**
   * Quarantine stamp (0121 MM-6). Seam ON: internal writes are
   * affirmatively 'clean', external ingest starts 'quarantined'. Seam
   * OFF: the field is NEVER written (byte-identical row) and
   * external_ingest is REJECTED — fail closed, no external bytes may
   * enter without the seam. 503 (not 400): retryable operator state,
   * the same class as the master-flag gate.
   */
  private quarantineStampFor(
    origin: 'internal' | 'external_ingest' | undefined,
  ): 'clean' | 'quarantined' | undefined {
    if (!evidenceQuarantineEnabled()) {
      if (origin === 'external_ingest') {
        throw new ServiceUnavailableException('external ingest requires EVIDENCE_QUARANTINE');
      }
      return undefined;
    }
    return origin === 'external_ingest' ? 'quarantined' : 'clean';
  }

  /** Shape checks that need no I/O — extracted for max-lines discipline. */
  private validateAssetShape(input: RegisterAssetInput): void {
    if (!MODALITIES.has(input.modality)) {
      throw new BadRequestException(`invalid modality '${String(input.modality)}'`);
    }
    if (!MEDIA_TYPE_RE.test(input.mediaType)) {
      throw new BadRequestException(`mediaType is not an IANA type/subtype shape`);
    }
    if (!HASH_RE.test(input.byteHash)) {
      throw new BadRequestException('byteHash must be 64 lowercase hex chars (sha256)');
    }
    const cap = evidenceMaxBytes();
    if (!Number.isInteger(input.byteLength) || input.byteLength <= 0 || input.byteLength > cap) {
      throw new BadRequestException(`byteLength must be a positive int <= ${cap}`);
    }
  }

  /**
   * Availability derivation (the 0109 contract):
   *   storageRef present → its scheme must resolve to a registered
   *   adapter AND adapter.head() must find the blob AND the blob's
   *   byteLength must equal the declared one (else 400) → 'hot';
   *   else originUri present → 'external'; neither → 400.
   * Every adapter must affirm tenant ownership — a cross-tenant blob
   * reference is a 400, not a dedup. This lives in the generic adapter
   * contract so a future s3:// implementation cannot forget the fence.
   */
  private async deriveAvailability(companyId: string, input: RegisterAssetInput): Promise<string> {
    if (input.storageRef) {
      const scheme = storageRefScheme(input.storageRef);
      const adapter = scheme ? this.adapters.get(scheme) : undefined;
      if (!adapter) {
        throw new BadRequestException(`storageRef scheme '${String(scheme)}' has no adapter`);
      }
      if (!adapter.belongsToTenant(companyId, input.storageRef)) {
        throw new BadRequestException('storageRef does not belong to this tenant');
      }
      const head = await adapter.head(input.storageRef);
      if (!head) throw new BadRequestException('storageRef does not resolve to a stored blob');
      if (head.byteLength !== input.byteLength) {
        throw new BadRequestException(
          `declared byteLength ${input.byteLength} != stored ${head.byteLength}`,
        );
      }
      return 'hot';
    }
    if (input.originUri) return 'external';
    throw new BadRequestException('an asset needs storageRef or originUri');
  }

  /** Add a citation-target fragment to an existing asset. */
  async addFragment(companyId: string, input: AddFragmentInput): Promise<{ fragmentId: string }> {
    this.gate();
    return this.surreal.withCompany(companyId, async (db) => {
      const asset = await queryFirst<{ id: unknown; modality: string; availability: string }>(
        db,
        `SELECT id, modality, availability
           FROM type::record('evidence_asset', $tail) LIMIT 1`,
        { tail: idTailOf(input.assetId) },
      );
      if (!asset) throw new NotFoundException(`asset ${input.assetId} not found`);
      if (asset.availability === 'gone') {
        throw new ConflictException(`asset ${input.assetId} is no longer available`);
      }
      const err = validateLocator(asset.modality, input.locator);
      if (err) throw new BadRequestException(`invalid locator: ${err}`);
      // Label rides the 0106 sceneLabel discipline: redact then cap.
      const label =
        input.label !== undefined
          ? redactPiiWithReport(input.label).text.slice(0, LABEL_MAX)
          : undefined;
      const row = await dbCreate<Record<string, unknown>>(db, 'evidence_fragment', {
        assetId: asset.id,
        locator: input.locator,
        label,
        piiClasses: input.piiClasses,
      });
      return { fragmentId: String(row.id) };
    });
  }

  /** Add one derived representation to an asset or fragment. */
  async addRepresentation(
    companyId: string,
    input: AddRepresentationInput,
  ): Promise<{ representationId: string }> {
    this.gate();
    const expectedPrefix = input.subjectKind === 'asset' ? 'evidence_asset:' : 'evidence_fragment:';
    if (!input.subjectId.startsWith(expectedPrefix)) {
      throw new BadRequestException(
        `subjectId must be a ${expectedPrefix.slice(0, -1)} record for subjectKind '${input.subjectKind}'`,
      );
    }
    if (!REPR_KINDS.has(input.kind)) {
      throw new BadRequestException(`invalid representation kind '${input.kind}'`);
    }
    if (!input.producerVersion || input.producerVersion.trim() === '') {
      throw new BadRequestException('producerVersion is required');
    }
    if (input.producedByRun !== undefined && !input.producedByRun.startsWith('processing_run:')) {
      throw new BadRequestException('producedByRun must be a processing_run record id');
    }
    return this.surreal.withCompany(companyId, async (db) => {
      const subject = await queryFirst<{ id: unknown; availability: string }>(
        db,
        input.subjectKind === 'asset'
          ? `SELECT id, availability
               FROM type::record('evidence_asset', $tail) LIMIT 1`
          : `SELECT id, assetId.availability AS availability
               FROM type::record('evidence_fragment', $tail) LIMIT 1`,
        { tail: idTailOf(input.subjectId) },
      );
      if (!subject) throw new NotFoundException(`subject ${input.subjectId} not found`);
      if (subject.availability === 'gone') {
        throw new ConflictException(`subject ${input.subjectId} belongs to unavailable evidence`);
      }
      const row = await dbCreate<Record<string, unknown>>(db, 'derived_representation', {
        subjectId: subject.id,
        subjectKind: input.subjectKind,
        kind: input.kind,
        content: input.content,
        model: input.model,
        modelVersion: input.modelVersion,
        promptVersion: input.promptVersion,
        confidence: input.confidence,
        lang: input.lang,
        producerVersion: input.producerVersion,
        // Key OMITTED when absent — non-broker writes stay byte-identical.
        ...(input.producedByRun !== undefined
          ? { producedByRun: new StringRecordId(input.producedByRun) }
          : {}),
      });
      return { representationId: String(row.id) };
    });
  }

  /** Read one asset row (tests + future PRs). */
  async getAsset(companyId: string, assetId: string): Promise<Record<string, unknown> | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const row = await queryFirst<Record<string, unknown>>(
        db,
        `SELECT * FROM type::record('evidence_asset', $tail)`,
        { tail: idTailOf(assetId) },
      );
      return row ?? null;
    });
  }

  /**
   * Delete a blob through its scheme adapter, best-effort: failures are
   * logged, never thrown — the GDPR row cascade must not abort on a blob
   * hiccup (the reconciliation sweep retries what this misses). Returns
   * true when a blob was actually removed.
   */
  async deleteBlobBestEffort(storageRef: string): Promise<boolean> {
    try {
      const scheme = storageRefScheme(storageRef);
      const adapter = scheme ? this.adapters.get(scheme) : undefined;
      if (!adapter) {
        this.logger.warn(`no adapter for storageRef scheme; blob not deleted: ${storageRef}`);
        return false;
      }
      return await adapter.delete(storageRef);
    } catch (e) {
      this.logger.warn(`blob delete failed for ${storageRef}: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Retention + reconciliation legs, called from the nightly candidate
   * sweeper. Retention: assets past retainUntil lose fragments,
   * representations, and their blob; the header row survives as a
   * tombstone (availability='gone', 0048 'purged' precedent). A blob
   * whose delete FAILS keeps its storageRef so the reconciliation leg —
   * assets 'gone' with a storageRef still set — retries next run: GDPR
   * bytes must not outlive their rows just because one unlink failed.
   */
  async sweepTenantEvidence(companyId: string): Promise<Record<string, number>> {
    return this.surreal.withCompany(companyId, async (db) => {
      const expired = await queryRows<{ id: unknown; storageRef?: string }>(
        db,
        `SELECT id, storageRef FROM evidence_asset
          WHERE retainUntil != NONE AND retainUntil < time::now()
            AND availability != 'gone'`,
      );
      let blobsDeleted = 0;
      for (const asset of expired) {
        // Close the write gate before purging dependents. If the process
        // crashes from here onward, the gone-row reconciliation leg below
        // resumes both the row and blob cleanup on the next sweep.
        await db.query(`UPDATE $id SET availability = 'gone'`, { id: asset.id });
        await this.purgeAssetDependents(db, asset.id);
        const cleared = asset.storageRef ? await this.deleteBlobBestEffort(asset.storageRef) : true;
        if (asset.storageRef && cleared) blobsDeleted++;
        // Failed blob delete keeps storageRef for the reconciliation leg.
        if (cleared) await db.query(`UPDATE $id SET storageRef = NONE`, { id: asset.id });
      }
      const supersededPurged = await this.purgeSupersededRepresentations(db);
      const reconciled = await this.reconcileGoneBlobs(db);
      const gc = await this.reconcileQueuedBlobs(db);
      if (expired.length > 0 || supersededPurged > 0 || reconciled > 0 || gc.reconciled > 0) {
        this.logger.log(
          `evidence sweep ${companyId}: expired=${expired.length} blobs=${blobsDeleted} superseded=${supersededPurged} reconciled=${reconciled} gc=${gc.reconciled}/${gc.scanned}`,
        );
      }
      return {
        evidenceExpired: expired.length,
        evidenceBlobsDeleted: blobsDeleted,
        evidenceSupersededPurged: supersededPurged,
        evidenceBlobsReconciled: reconciled,
        evidenceBlobGcReconciled: gc.reconciled,
        evidenceBlobGcPending: gc.pending,
      };
    });
  }

  /**
   * Superseded-orphan leg (0121): representations that a re-processing
   * run replaced (supersededBy set — the old generation) are collected
   * here, NOT at supersede time, so an in-flight reader never loses its
   * citation target mid-answer. Unconditional (no flag): such rows exist
   * only if the broker ever ran, so no-flag prod is byte-identical.
   * Row-only — representations carry no blobs and no outbox rows. The
   * single-field derived_repr_superseded_idx covers the WHERE; the
   * two-step SELECT-ids → DELETE $ids shape is the 3.2.4 discipline.
   */
  private async purgeSupersededRepresentations(db: Surreal): Promise<number> {
    let purged = 0;
    for (;;) {
      const ids = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM derived_representation WHERE supersededBy != NONE LIMIT 5000`,
      );
      if (ids.length === 0) break;
      await db.query(`DELETE $ids RETURN BEFORE`, { ids });
      purged += ids.length;
      if (ids.length < 5000) break;
    }
    return purged;
  }

  /**
   * Quarantine-rejection tombstone (0121 MM-6) — the RETENTION path
   * reused verbatim: availability='gone' closes the write gate,
   * dependents (representations, fragments, processing runs) die, the
   * blob goes best-effort. A FAILED blob delete keeps storageRef so
   * reconcileGoneBlobs retries next sweep (0114 doctrine — no new outbox
   * reason). Runs REGARDLESS of flags: delete side, erasability doctrine.
   * The caller (EvidenceQuarantineService) stamps quarantineStatus.
   */
  async tombstoneAssetBytes(companyId: string, assetId: string): Promise<{ blobDeleted: boolean }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const row = await queryFirst<{ id: unknown; storageRef?: string }>(
        db,
        `SELECT id, storageRef FROM type::record('evidence_asset', $tail) LIMIT 1`,
        { tail: idTailOf(assetId) },
      );
      if (!row) return { blobDeleted: false };
      await db.query(`UPDATE $id SET availability = 'gone'`, { id: row.id });
      await this.purgeAssetDependents(db, row.id);
      const cleared = row.storageRef ? await this.deleteBlobBestEffort(row.storageRef) : false;
      if (cleared) await db.query(`UPDATE $id SET storageRef = NONE`, { id: row.id });
      return { blobDeleted: cleared };
    });
  }

  /**
   * Representations then fragments of one dying asset, batched by
   * explicit ids. Representations MUST be exhausted before their fragment
   * rows disappear: otherwise >5000 representations over one fragment
   * become undiscoverable orphans after the first batch. The two-step
   * SELECT-ids → DELETE-ids shape also avoids SurrealDB 3.2.4's
   * compound/traversal DELETE-WHERE planner no-op class.
   */
  private async purgeAssetDependents(db: Surreal, assetId: unknown): Promise<void> {
    await this.purgeRepresentationBatches(db, `subjectId = $asset`, { asset: assetId });
    for (;;) {
      const fragIds = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM evidence_fragment WHERE assetId = $asset LIMIT 5000`,
        { asset: assetId },
      );
      if (fragIds.length === 0) break;
      await this.purgeRepresentationBatches(db, `subjectId INSIDE $subjects`, {
        subjects: fragIds,
      });
      await db.query(`DELETE $ids RETURN BEFORE`, { ids: fragIds });
      if (fragIds.length < 5000) break;
    }
    // Processing runs (0121) go LAST: run rows are discoverable via
    // assetId, which survives as the tombstone header, so batch
    // exhaustion is safe in any order — but after the repr+frag legs the
    // asset's content-bearing rows are already gone if we crash here.
    for (;;) {
      const runIds = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM processing_run WHERE assetId = $asset LIMIT 5000`,
        { asset: assetId },
      );
      if (runIds.length === 0) break;
      await db.query(`DELETE $ids RETURN BEFORE`, { ids: runIds });
      if (runIds.length < 5000) break;
    }
  }

  private async purgeRepresentationBatches(
    db: Surreal,
    where: string,
    vars: Record<string, unknown>,
  ): Promise<void> {
    for (;;) {
      const ids = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM derived_representation WHERE ${where} LIMIT 5000`,
        vars,
      );
      if (ids.length === 0) break;
      await db.query(`DELETE $ids RETURN BEFORE`, { ids });
      if (ids.length < 5000) break;
    }
  }

  /** Retry blob deletion for 'gone' rows still holding a storageRef. */
  private async reconcileGoneBlobs(db: Surreal): Promise<number> {
    const stragglers = await queryRows<{ id: unknown; storageRef: string }>(
      db,
      `SELECT id, storageRef FROM evidence_asset
        WHERE availability = 'gone' AND storageRef != NONE`,
    );
    let reconciled = 0;
    for (const row of stragglers) {
      // Also repairs a crash after the asset was marked gone but before
      // its dependent rows were fully removed.
      await this.purgeAssetDependents(db, row.id);
      // deleteBlobBestEffort returns false when the blob is ALREADY gone
      // (ENOENT) — the ref is stale either way, so clear it unless the
      // adapter threw/was missing, in which case exists() still finding
      // the blob keeps the ref for the next run.
      const removed = await this.deleteBlobBestEffort(row.storageRef);
      const stillThere = !removed && (await this.blobStillExists(row.storageRef));
      if (!stillThere) {
        await db.query(`UPDATE $id SET storageRef = NONE`, { id: row.id });
        reconciled++;
      }
    }
    return reconciled;
  }

  /** Drain a bounded page of the durable hard-erasure blob outbox (0114). */
  private async reconcileQueuedBlobs(
    db: Surreal,
  ): Promise<{ scanned: number; reconciled: number; pending: number }> {
    const queued = await queryRows<{ id: unknown; storageRef: string }>(
      db,
      `SELECT id, storageRef, queuedAt FROM evidence_blob_gc ORDER BY queuedAt ASC LIMIT 500`,
    );
    let reconciled = 0;
    for (const row of queued) {
      const removed = await this.deleteBlobBestEffort(row.storageRef);
      const stillThere = !removed && (await this.blobStillExists(row.storageRef));
      if (!stillThere) {
        const ids = await queryRows<unknown>(
          db,
          `SELECT VALUE id FROM evidence_blob_gc WHERE storageRef = $ref`,
          { ref: row.storageRef },
        );
        if (ids.length > 0) await db.query(`DELETE $ids`, { ids });
        reconciled++;
      } else {
        await db.query(`UPDATE $id SET attempts += 1, lastAttemptAt = time::now()`, { id: row.id });
      }
    }
    const pendingRow = await queryFirst<{ count?: number }>(
      db,
      `SELECT count() AS count FROM evidence_blob_gc GROUP ALL`,
    );
    return { scanned: queued.length, reconciled, pending: Number(pendingRow?.count ?? 0) };
  }

  /** Confirm absence through the registry; unknown/missing adapter stays pending. */
  private async blobStillExists(storageRef: string): Promise<boolean> {
    try {
      const scheme = storageRefScheme(storageRef);
      const adapter = scheme ? this.adapters.get(scheme) : undefined;
      return adapter ? await adapter.exists(storageRef) : true;
    } catch {
      return true; // unknown state — keep the ref, retry next run
    }
  }
}
