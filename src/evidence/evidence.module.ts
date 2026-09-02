import { Module } from '@nestjs/common';
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
 * scheme, never by concrete class. No controller in this PR (the ingest
 * surface is sibling PR-C). Injections into the GDPR / sweeper paths are
 * @Optional so positionally-constructed unit fixtures stay valid.
 * SurrealService comes from the @Global db module.
 *
 * Processing lifecycle (migration 0121): the trusted processor broker
 * (adapter registry array — first match wins at dispatch), the
 * idempotent run service, and the quarantine seam with its allow-all
 * scan-hook STUB. Adapters are PLATFORM code registered HERE — a pack
 * can only declare needs, never supply processors (anti-DSL doctrine).
 * All of it default-off behind EVIDENCE_PROCESSOR_BROKER /
 * EVIDENCE_QUARANTINE; exports exist for tests and future PR-C
 * consumers.
 */
@Module({
  providers: [
    FsEvidenceStorageAdapter,
    {
      provide: EVIDENCE_STORAGE_ADAPTERS,
      useFactory: (fs: EvidenceStorageAdapter): EvidenceStorageRegistry =>
        new Map([[fs.scheme, fs]]),
      inject: [FsEvidenceStorageAdapter],
    },
    EvidenceStoreService,
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
