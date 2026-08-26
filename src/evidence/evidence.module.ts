import { Module } from '@nestjs/common';
import { EvidenceStoreService } from './evidence-store.service';
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
  ],
  exports: [EvidenceStoreService],
})
export class EvidenceModule {}
