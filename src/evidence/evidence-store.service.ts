import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  isUniqueViolation,
  queryFirst,
  queryRows,
} from '../db/surreal.service';
import { evidenceMaxBytes, evidenceSubstrateEnabled } from '../common/evidence-flags';
import { idTailOf, redactPiiWithReport } from '../ingest/ingest-utils';
import { validateLocator } from './locator';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  EvidenceStorageRegistry,
  storageRefScheme,
} from './storage/storage-adapter';
import { parseStorageRef } from './storage/fs-storage.adapter';

const HASH_RE = /^[0-9a-f]{64}$/;
// IANA media-type shape (type "/" subtype over the registered-name
// charset) — open vocabulary, shape-only (0048 `kind` doctrine).
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const MODALITIES = ['image', 'audio', 'video', 'document', 'sensor'] as const;
const LABEL_MAX = 200;
const REPR_KINDS = ['caption', 'ocr', 'asr', 'object_track', 'scene_graph', 'embedding', 'text'];

export type EvidenceModality = (typeof MODALITIES)[number];

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
  kind: string;
  content?: string | undefined;
  model?: string | undefined;
  modelVersion?: string | undefined;
  promptVersion?: string | undefined;
  confidence?: number | undefined;
  lang?: string | undefined;
  producerVersion: string;
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

  /** Shape checks that need no I/O — extracted for max-lines discipline. */
  private validateAssetShape(input: RegisterAssetInput): void {
    if (!MODALITIES.includes(input.modality)) {
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
   * For the fs scheme the ref's embedded tenant must be the calling
   * tenant — a cross-tenant blob reference is a 400, not a dedup.
   */
  private async deriveAvailability(companyId: string, input: RegisterAssetInput): Promise<string> {
    if (input.storageRef) {
      const scheme = storageRefScheme(input.storageRef);
      const adapter = scheme ? this.adapters.get(scheme) : undefined;
      if (!adapter) {
        throw new BadRequestException(`storageRef scheme '${String(scheme)}' has no adapter`);
      }
      if (scheme === 'fs' && parseStorageRef(input.storageRef)?.companyId !== companyId) {
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
      const asset = await queryFirst<{ id: unknown; modality: string }>(
        db,
        `SELECT id, modality FROM type::record('evidence_asset', $tail) LIMIT 1`,
        { tail: idTailOf(input.assetId) },
      );
      if (!asset) throw new NotFoundException(`asset ${input.assetId} not found`);
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
    if (!REPR_KINDS.includes(input.kind)) {
      throw new BadRequestException(`invalid representation kind '${input.kind}'`);
    }
    if (!input.producerVersion || input.producerVersion.trim() === '') {
      throw new BadRequestException('producerVersion is required');
    }
    return this.surreal.withCompany(companyId, async (db) => {
      const subject = await queryFirst<{ id: unknown }>(
        db,
        input.subjectKind === 'asset'
          ? `SELECT id FROM type::record('evidence_asset', $tail) LIMIT 1`
          : `SELECT id FROM type::record('evidence_fragment', $tail) LIMIT 1`,
        { tail: idTailOf(input.subjectId) },
      );
      if (!subject) throw new NotFoundException(`subject ${input.subjectId} not found`);
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
        await this.purgeAssetDependents(db, asset.id);
        const cleared = asset.storageRef ? await this.deleteBlobBestEffort(asset.storageRef) : true;
        if (asset.storageRef && cleared) blobsDeleted++;
        // Failed blob delete keeps storageRef for the reconciliation leg.
        await db.query(
          cleared
            ? `UPDATE $id SET availability = 'gone', storageRef = NONE`
            : `UPDATE $id SET availability = 'gone'`,
          { id: asset.id },
        );
      }
      const reconciled = await this.reconcileGoneBlobs(db);
      if (expired.length > 0 || reconciled > 0) {
        this.logger.log(
          `evidence sweep ${companyId}: expired=${expired.length} blobs=${blobsDeleted} reconciled=${reconciled}`,
        );
      }
      return {
        evidenceExpired: expired.length,
        evidenceBlobsDeleted: blobsDeleted,
        evidenceBlobsReconciled: reconciled,
      };
    });
  }

  /**
   * Fragments then representations of one dying asset, LET-batched
   * (LIMIT 5000 loop) by explicit ids — the 3.2.4 compound/traversal
   * DELETE-WHERE planner no-op class (preSweepOutcomeRows, PR #372)
   * makes a one-step DELETE-WHERE on the fragment table untrustworthy.
   */
  private async purgeAssetDependents(db: Surreal, assetId: unknown): Promise<void> {
    for (;;) {
      const [, , fragBatch, reprBatch] = await db.query<[unknown, unknown, unknown[], unknown[]]>(
        `LET $fragIds = (SELECT VALUE id FROM evidence_fragment
           WHERE assetId = $asset LIMIT 5000);
         LET $reprIds = (SELECT VALUE id FROM derived_representation
           WHERE subjectId = $asset OR subjectId INSIDE $fragIds LIMIT 5000);
         DELETE $fragIds RETURN BEFORE;
         DELETE $reprIds RETURN BEFORE;`,
        { asset: assetId },
      );
      const frags = ((fragBatch as unknown[]) ?? []).length;
      const reprs = ((reprBatch as unknown[]) ?? []).length;
      if (frags < 5000 && reprs < 5000) break;
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

  /** exists() through the registry, false on any failure. */
  private async blobStillExists(storageRef: string): Promise<boolean> {
    try {
      const scheme = storageRefScheme(storageRef);
      const adapter = scheme ? this.adapters.get(scheme) : undefined;
      return adapter ? await adapter.exists(storageRef) : false;
    } catch {
      return true; // unknown state — keep the ref, retry next run
    }
  }
}
