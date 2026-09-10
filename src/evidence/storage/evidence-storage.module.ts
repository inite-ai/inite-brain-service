import { Global, Module } from '@nestjs/common';
import { evidenceS3Config } from '../../common/evidence-flags';
import { FsEvidenceStorageAdapter } from './fs-storage.adapter';
import { S3EvidenceStorageAdapter } from './s3-storage.adapter';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  type EvidenceStorageAdapter,
  type EvidenceStorageRegistry,
} from './storage-adapter';

/**
 * EvidenceStorageModule — the blob-adapter registry, @Global so the
 * readiness report (HealthService) and the capability probe can reach
 * the SELECTED store without importing the whole evidence module. fs is
 * always registered (its methods throw the clear unconfigured error
 * while EVIDENCE_FS_ROOT is unset); s3 registers only when
 * EVIDENCE_S3_BUCKET is set, so a deployment that never mentions S3 has
 * no adapter that could throw — the orphan sweep walks EVERY registered
 * adapter. Which one takes uploads is EVIDENCE_STORAGE_SCHEME; reads
 * resolve by the row's own ref scheme, so both can serve at once.
 */
@Global()
@Module({
  providers: [
    FsEvidenceStorageAdapter,
    S3EvidenceStorageAdapter,
    {
      provide: EVIDENCE_STORAGE_ADAPTERS,
      useFactory: (
        fs: FsEvidenceStorageAdapter,
        s3: S3EvidenceStorageAdapter,
      ): EvidenceStorageRegistry => {
        const registry = new Map<string, EvidenceStorageAdapter>([[fs.scheme, fs]]);
        if (evidenceS3Config() !== null) registry.set(s3.scheme, s3);
        return registry;
      },
      inject: [FsEvidenceStorageAdapter, S3EvidenceStorageAdapter],
    },
  ],
  exports: [FsEvidenceStorageAdapter, S3EvidenceStorageAdapter, EVIDENCE_STORAGE_ADAPTERS],
})
export class EvidenceStorageModule {}
