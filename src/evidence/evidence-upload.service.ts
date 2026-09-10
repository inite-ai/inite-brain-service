import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  evidenceMaxBytes,
  evidenceStorageScheme,
  processorBrokerEnabled,
} from '../common/evidence-flags';
import type { EvidenceModality } from '../common/evidence-taxonomy';
import type { MediaPiiClass } from '../common/media-pii';
import type { UploadedEvidenceBlob } from './blob-upload.interceptor';
import { EvidenceStoreService } from './evidence-store.service';
import { EvidenceProcessorBrokerService } from './processor-broker.service';
import { EvidenceQuarantineService } from './quarantine.service';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  type EvidenceStorageAdapter,
  type EvidenceStorageRegistry,
} from './storage/storage-adapter';
import { normalizeUploadMediaType, uploadMediaTypeError } from './upload-media-types';

export interface UploadEvidenceBlobInput {
  modality: EvidenceModality;
  /** Overrides the multipart part's own Content-Type when present. */
  mediaType?: string | undefined;
  occurredAt: Date;
  vertical: string;
  userId?: string | undefined;
  scope?: string[] | undefined;
  piiClasses?: MediaPiiClass[] | undefined;
  recorder?: string | undefined;
  retainUntil?: Date | undefined;
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  pageCount?: number | undefined;
  /** Optional fire-and-forget processor dispatch target. */
  packId?: string | undefined;
}

export interface UploadEvidenceBlobResult {
  assetId: string;
  /** 'hot' for a fresh upload; a dedup returns the existing row's state. */
  availability: string;
  deduped: boolean;
  /** sha256 computed over the RECEIVED bytes — the 0109 asset identity. */
  byteHash: string;
  byteLength: number;
  storageRef: string;
  mediaType: string;
  /**
   * Post-scan state. 'clean' = the scan hook passed and the asset is
   * dispatchable; 'scanning' = the hook could not render a verdict, so
   * the asset stays quarantined-closed (the quarantine service's own
   * behaviour on a throwing hook) and is re-scannable. 'rejected' never
   * appears here — it answers 422.
   */
  quarantineStatus: 'clean' | 'scanning';
  /** Whether a broker dispatch was STARTED (never whether it succeeded). */
  dispatched: boolean;
}

/**
 * EvidenceUploadService (Brain v2.1 MM-7) — the byte-ingest pipeline
 * behind POST /v1/ingest/evidence-blob, composed entirely out of seams
 * that already existed and had no production caller:
 *
 *   bytes → storage adapter put() → registerAsset(storageRef) → runScan()
 *         → (fire-and-forget) dispatchForPack()
 *
 * Each step keeps its own gate; this service invents no new ones:
 *
 *  - registerAsset passes `origin: 'external_ingest'`, so the store's own
 *    MM-6 fence applies — EVIDENCE_QUARANTINE off ⇒ 503 and NOTHING is
 *    registered. Bytes that arrive over HTTP are external ingest by
 *    definition; there is no honest way to call them internal.
 *  - availability is DERIVED, not asserted: the store re-heads the blob
 *    through the adapter registry and compares byte lengths, so a fresh
 *    upload lands 'hot' only because the bytes are genuinely there.
 *  - the scan is synchronous and BLOCKING (v1 has no scheduler): an
 *    upload's asset is never dispatchable before a verdict, and a
 *    'rejected' verdict has already tombstoned the row and deleted the
 *    blob by the time this service raises 422.
 *  - the broker dispatch is the ONLY step that may fail silently, and it
 *    is deliberately never awaited (see dispatch()).
 *
 * ORPHAN BLOBS. put() is content-addressed and idempotent, which means a
 * blob is SHARED by construction: the same bytes from a second caller
 * land on the same ref. So when registerAsset throws (409 on another
 * principal's hash, or any transient failure) this service does NOT
 * delete what it just wrote — the bytes may already be another row's.
 * An unreferenced blob is inert (no row ⇒ not servable, not enumerable,
 * not dispatchable) and is reused verbatim by the next successful
 * registration of the same content. The ONE case where deletion is
 * provably safe is a 'rejected' verdict: a rejected asset never keeps a
 * storageRef, so nothing can reference those bytes.
 */
@Injectable()
export class EvidenceUploadService {
  private readonly logger = new Logger(EvidenceUploadService.name);

  // Four collaborators because the pipeline IS the composition of four
  // seams (store / blob storage / quarantine / broker); splitting it
  // would only move the wiring somewhere less obvious.
  // eslint-disable-next-line max-params
  constructor(
    private readonly store: EvidenceStoreService,
    @Inject(EVIDENCE_STORAGE_ADAPTERS)
    private readonly adapters: EvidenceStorageRegistry,
    private readonly quarantine: EvidenceQuarantineService,
    private readonly broker: EvidenceProcessorBrokerService,
  ) {}

  async upload(
    companyId: string,
    blob: UploadedEvidenceBlob,
    input: UploadEvidenceBlobInput,
  ): Promise<UploadEvidenceBlobResult> {
    const mediaType = this.checkShape(blob, input);
    const adapter = this.adapter();
    const byteHash = createHash('sha256').update(blob.buffer).digest('hex');
    const { storageRef } = await this.put(adapter, { companyId, byteHash, data: blob.buffer });
    const asset = await this.store.registerAsset(companyId, {
      modality: input.modality,
      mediaType,
      byteHash,
      byteLength: blob.buffer.byteLength,
      occurredAt: input.occurredAt,
      // The bytes ARE in our custody now — storageRef, never originUri.
      storageRef,
      origin: 'external_ingest',
      vertical: input.vertical,
      userId: input.userId,
      scope: input.scope,
      piiClasses: input.piiClasses,
      recorder: input.recorder,
      retainUntil: input.retainUntil,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
      pageCount: input.pageCount,
    });
    const quarantineStatus = await this.scan(adapter, {
      companyId,
      assetId: asset.assetId,
      storageRef,
    });
    return {
      assetId: asset.assetId,
      availability: asset.availability,
      deduped: asset.deduped,
      byteHash,
      byteLength: blob.buffer.byteLength,
      storageRef,
      mediaType,
      quarantineStatus,
      dispatched:
        quarantineStatus === 'clean' && this.dispatch(companyId, asset.assetId, input.packId),
    };
  }

  /** Size + media-type admission. Returns the effective media type. */
  private checkShape(blob: UploadedEvidenceBlob, input: UploadEvidenceBlobInput): string {
    const bytes = blob.buffer.byteLength;
    if (bytes === 0) throw new BadRequestException('the uploaded file part is empty');
    const cap = evidenceMaxBytes();
    // Belt to the interceptor's braces: multer already refuses an
    // over-cap part mid-stream, but the cap is runtime-mutable and this
    // is the check the write seam would otherwise fail on with a
    // confusing "declared byteLength" message.
    if (bytes > cap) {
      throw new PayloadTooLargeException(`uploaded bytes (${bytes}) exceed the cap of ${cap}`);
    }
    const mediaType = input.mediaType ?? blob.mimetype;
    const err = uploadMediaTypeError(input.modality, mediaType);
    if (err) throw new BadRequestException(err);
    // The CANONICAL form is what the row stores: an accepted part sent as
    // `text/plain; charset=utf-8` must not produce a different asset row
    // than the same bytes sent as `text/plain`.
    return normalizeUploadMediaType(mediaType);
  }

  /**
   * The adapter for the SELECTED scheme (EVIDENCE_STORAGE_SCHEME, read
   * per call), or a loud retryable operator error. Resolving by scheme
   * rather than by concrete class keeps the seam the rest of the
   * substrate uses; s3 selected with no s3 adapter registered
   * (EVIDENCE_S3_BUCKET unset at boot) is a 503, never a silent
   * fall-back to local disk.
   */
  private adapter(): EvidenceStorageAdapter {
    const scheme = evidenceStorageScheme();
    const adapter = this.adapters.get(scheme);
    if (!adapter) {
      throw new ServiceUnavailableException(
        `no '${scheme}' storage adapter is registered — ` +
          'the blob upload surface has nowhere to put bytes',
      );
    }
    return adapter;
  }

  /**
   * Store the bytes. An adapter failure (EVIDENCE_FS_ROOT unset, a full
   * disk, a permission problem) is OPERATOR state, not caller error —
   * 503, and the message stays the adapter's own so the operator can act
   * on it. Nothing has been written to the DB at this point.
   */
  private async put(
    adapter: EvidenceStorageAdapter,
    blob: { companyId: string; byteHash: string; data: Buffer },
  ): Promise<{ storageRef: string }> {
    try {
      return await adapter.put(blob.companyId, blob.byteHash, blob.data);
    } catch (e) {
      const message = (e as Error).message;
      this.logger.error(`evidence blob put failed for ${blob.companyId}: ${message}`);
      throw new ServiceUnavailableException(`evidence blob storage is unavailable: ${message}`);
    }
  }

  /**
   * Scan-before-serve. The quarantine service owns every state
   * transition; this only maps its three outcomes onto the HTTP surface:
   *
   *   clean     → the asset is dispatchable, 201;
   *   rejected  → the row is already a tombstone and the bytes are gone,
   *               422 with a content-free message (a scan verdict must
   *               not describe what it matched on);
   *   throw     → the service left the asset 'scanning', which the
   *               dispatch gate denies. Fail CLOSED and say so in the
   *               response rather than pretending the scan passed.
   */
  private async scan(
    adapter: EvidenceStorageAdapter,
    asset: { companyId: string; assetId: string; storageRef: string },
  ): Promise<'clean' | 'scanning'> {
    let verdict: 'clean' | 'rejected' | null = null;
    try {
      verdict = (await this.quarantine.runScan(asset.companyId, asset.assetId)).quarantineStatus;
    } catch (e) {
      this.logger.warn(
        `evidence scan for ${asset.assetId} did not complete (${(e as Error).message}) — ` +
          'the asset stays quarantined and dispatch-denied',
      );
    }
    if (verdict !== 'rejected') return verdict === 'clean' ? 'clean' : 'scanning';
    // The reject leg already tombstoned + deleted. The TERMINAL no-op
    // (bytes rejected on an earlier upload, re-uploaded now) did not —
    // and a rejected asset never keeps a storageRef, so removing what we
    // just re-materialised cannot strand another row's bytes.
    await adapter.delete(asset.storageRef).catch(() => false);
    throw new UnprocessableEntityException('the uploaded evidence was rejected by the scan hook');
  }

  /**
   * Fire-and-forget processor dispatch. NEVER awaited and never able to
   * fail the upload: the bytes are already stored, registered and
   * scanned, so an unknown pack or a broken adapter must not turn a
   * successful ingestion into an error. Returns whether a dispatch was
   * started, not whether it will succeed. Off (EVIDENCE_PROCESSOR_BROKER)
   * or with no packId ⇒ nothing is scheduled at all.
   */
  private dispatch(companyId: string, assetId: string, packId: string | undefined): boolean {
    if (packId === undefined || packId.trim() === '' || !processorBrokerEnabled()) return false;
    void this.broker
      .dispatchForPack(companyId, { packId, assetId })
      .then((res) => {
        for (const denial of res.denied) {
          this.logger.debug(`dispatch ${assetId}/${denial.capability} denied: ${denial.reason}`);
        }
      })
      .catch((e: unknown) => {
        this.logger.warn(
          `post-upload dispatch for ${assetId} (pack ${packId}) failed: ${(e as Error).message}`,
        );
      });
    return true;
  }
}
