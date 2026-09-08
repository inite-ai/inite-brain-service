import { Module } from '@nestjs/common';
import { EvidenceBlobUploadInterceptor } from './blob-upload.interceptor';
import { EvidenceAdminController } from './evidence-admin.controller';
import { EvidenceGrantService } from './evidence-grant.service';
import { EvidenceGrantsController } from './evidence-grants.controller';
import { EvidenceGrantsEnabledGuard } from './evidence-grants.guard';
import { EvidenceIngestController } from './evidence-ingest.controller';
import { EvidenceReadController } from './evidence-read.controller';
import { EvidenceReadService } from './evidence-read.service';
import { EvidenceStoreService } from './evidence-store.service';
import { EvidenceUploadService } from './evidence-upload.service';
import { EvidenceOrphanBlobGcService } from './orphan-blob-gc.service';
import { EvidenceProcessorBrokerService } from './processor-broker.service';
import { EvidenceQuarantineService } from './quarantine.service';
import { DocumentTextAdapter } from './processing/adapters/document-text.adapter';
import { ImageMetadataAdapter } from './processing/adapters/image-metadata.adapter';
import { TextExtractionPassthroughAdapter } from './processing/adapters/text-extraction-passthrough.adapter';
import {
  EVIDENCE_PROCESSOR_ADAPTERS,
  ProcessorAdapter,
  ProcessorAdapterRegistry,
} from './processing/processor-adapter';
import { ProcessingRunService } from './processing/processing-run.service';
import { AllowAllScanHook, EVIDENCE_SCAN_HOOK } from './processing/scan-hook';
import { FsEvidenceStorageAdapter } from './storage/fs-storage.adapter';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  EvidenceStorageAdapter,
  EvidenceStorageRegistry,
} from './storage/storage-adapter';

/**
 * Evidence substrate (migration 0109): the multimodal Evidence Plane
 * write seam (EvidenceStoreService) + the blob storage-adapter registry.
 * v1 registers ONE adapter (fs://); an s3-class adapter is a new
 * provider + one more Map entry — consumers resolve by storageRef
 * scheme, never by concrete class. EvidenceIngestController owns both
 * write-side HTTP surfaces — the metadata-only registration (POST
 * /v1/ingest/evidence-asset, EVIDENCE_INGEST_ENABLED) and the MM-7 byte
 * upload (POST /v1/ingest/evidence-blob, EVIDENCE_BLOB_UPLOAD_ENABLED:
 * multipart → storage adapter → registerAsset → scan → fire-and-forget
 * dispatch), both dark by default → bare 404; the read gateway
 * below is their bytes-out counterpart. Injections into the GDPR /
 * sweeper paths are @Optional so positionally-constructed unit
 * fixtures stay valid. SurrealService comes from the @Global db module.
 *
 * Processing lifecycle (migration 0121): the trusted processor broker
 * (adapter registry array — first match wins at dispatch), the
 * idempotent run service, and the quarantine seam with its allow-all
 * scan-hook STUB. Adapters are PLATFORM code registered HERE — a pack
 * can only declare needs, never supply processors (anti-DSL doctrine).
 * All of it default-off behind EVIDENCE_PROCESSOR_BROKER /
 * EVIDENCE_QUARANTINE; exports exist for tests and cross-module
 * consumers. EvidenceAdminController (MM-7) is the operator's entry into
 * the broker — POST /v1/admin/maintenance/evidence/dispatch, 404 while
 * the broker is dark, sweeping already-registered assets that no upload
 * dispatch covered. The same controller carries the delete-side sibling,
 * POST /v1/admin/maintenance/evidence/orphan-blob-gc
 * (EvidenceOrphanBlobGcService, EVIDENCE_ORPHAN_BLOB_GC): the sweep that
 * reclaims blobs no row references — bytes the upload path stores before
 * their row exists and, by content-addressed design, refuses to unlink
 * on a failed registration. Report-only until a second flag says
 * otherwise, and gated on its own flag ALONE — a delete-side pass must
 * stay usable after the write-side substrate is turned off.
 *
 * Real adapters: ImageMetadataAdapter (sharp/libvips — intrinsic image
 * facts + allowlisted EXIF, no GPS) REPLACES the 0121
 * ImageMetadataStubAdapter for the 'caption' capability, subsuming its
 * byte-less path; DocumentTextAdapter (pdf2json) joins
 * TextExtractionPassthroughAdapter under 'text' with a disjoint media
 * type (PDF vs text/*), so first-match dispatch stays unambiguous. Both
 * are no-network, no-key, deterministic local decodes.
 *
 * Raw-read gateway (MM-3, migration 0125): EvidenceReadController is
 * the ONE surface that serves original bytes back out — stream, signed-
 * URL mint, and the unauthenticated redeem — behind the full gate
 * ladder, default-off (EVIDENCE_RAW_READ_ENABLED → every route 404s).
 * Guard dependencies (ApiKeyGuard / policy gate) resolve from the
 * @Global auth/policy modules.
 *
 * Sharing surface (MM-4, migration 0122): EvidenceGrantsController is
 * the ownership counterpart of the read gateway — grant, list and revoke
 * over an asset, default-off (EVIDENCE_GRANTS_API_ENABLED, double-gated
 * on the substrate → every route 404s from EvidenceGrantsEnabledGuard,
 * before the ValidationPipe can advertise the route with a 400).
 * EvidenceGrantService owns its authorization ladder (the raw gateway's
 * ownership + media-PII fences, minus the byte-delivery steps) and
 * delegates every write to the ONE seam above. The guard is listed as a
 * provider so Nest resolves it by class in @UseGuards.
 */
@Module({
  controllers: [
    EvidenceIngestController,
    EvidenceReadController,
    EvidenceGrantsController,
    EvidenceAdminController,
  ],
  providers: [
    EvidenceGrantsEnabledGuard,
    EvidenceGrantService,
    FsEvidenceStorageAdapter,
    {
      provide: EVIDENCE_STORAGE_ADAPTERS,
      useFactory: (fs: EvidenceStorageAdapter): EvidenceStorageRegistry =>
        new Map([[fs.scheme, fs]]),
      inject: [FsEvidenceStorageAdapter],
    },
    EvidenceStoreService,
    EvidenceReadService,
    TextExtractionPassthroughAdapter,
    DocumentTextAdapter,
    ImageMetadataAdapter,
    {
      provide: EVIDENCE_PROCESSOR_ADAPTERS,
      useFactory: (
        text: ProcessorAdapter,
        pdf: ProcessorAdapter,
        image: ProcessorAdapter,
      ): ProcessorAdapterRegistry => [text, pdf, image],
      inject: [TextExtractionPassthroughAdapter, DocumentTextAdapter, ImageMetadataAdapter],
    },
    ProcessingRunService,
    EvidenceProcessorBrokerService,
    { provide: EVIDENCE_SCAN_HOOK, useClass: AllowAllScanHook },
    EvidenceQuarantineService,
    EvidenceBlobUploadInterceptor,
    EvidenceUploadService,
    EvidenceOrphanBlobGcService,
  ],
  exports: [
    EvidenceStoreService,
    EvidenceGrantService,
    ProcessingRunService,
    EvidenceProcessorBrokerService,
    EvidenceQuarantineService,
    EvidenceUploadService,
    EvidenceOrphanBlobGcService,
  ],
})
export class EvidenceModule {}
