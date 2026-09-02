import { Module } from '@nestjs/common';
import { EvidenceIngestController } from './evidence-ingest.controller';
import { EvidenceReadController } from './evidence-read.controller';
import { EvidenceReadService } from './evidence-read.service';
import { EvidenceStoreService } from './evidence-store.service';
import { EvidenceProcessorBrokerService } from './processor-broker.service';
import { EvidenceQuarantineService } from './quarantine.service';
import { ImageMetadataStubAdapter } from './processing/adapters/image-metadata-stub.adapter';
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
 * scheme, never by concrete class. The metadata-only ingest controller
 * (POST /v1/ingest/evidence-asset, dark behind EVIDENCE_INGEST_ENABLED
 * → bare 404) is the ONE write-side HTTP surface; the read gateway
 * below is its bytes-out counterpart. Injections into the GDPR /
 * sweeper paths are @Optional so positionally-constructed unit
 * fixtures stay valid. SurrealService comes from the @Global db module.
 *
 * Processing lifecycle (migration 0121): the trusted processor broker
 * (adapter registry array — first match wins at dispatch), the
 * idempotent run service, and the quarantine seam with its allow-all
 * scan-hook STUB. Adapters are PLATFORM code registered HERE — a pack
 * can only declare needs, never supply processors (anti-DSL doctrine).
 * All of it default-off behind EVIDENCE_PROCESSOR_BROKER /
 * EVIDENCE_QUARANTINE; exports exist for tests and future PR-C
 * consumers.
 *
 * Raw-read gateway (MM-3, migration 0125): EvidenceReadController is
 * the ONE surface that serves original bytes back out — stream, signed-
 * URL mint, and the unauthenticated redeem — behind the full gate
 * ladder, default-off (EVIDENCE_RAW_READ_ENABLED → every route 404s).
 * Guard dependencies (ApiKeyGuard / policy gate) resolve from the
 * @Global auth/policy modules.
 */
@Module({
  controllers: [EvidenceIngestController, EvidenceReadController],
  providers: [
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
    ImageMetadataStubAdapter,
    {
      provide: EVIDENCE_PROCESSOR_ADAPTERS,
      useFactory: (text: ProcessorAdapter, image: ProcessorAdapter): ProcessorAdapterRegistry => [
        text,
        image,
      ],
      inject: [TextExtractionPassthroughAdapter, ImageMetadataStubAdapter],
    },
    ProcessingRunService,
    EvidenceProcessorBrokerService,
    { provide: EVIDENCE_SCAN_HOOK, useClass: AllowAllScanHook },
    EvidenceQuarantineService,
  ],
  exports: [
    EvidenceStoreService,
    ProcessingRunService,
    EvidenceProcessorBrokerService,
    EvidenceQuarantineService,
  ],
})
export class EvidenceModule {}
