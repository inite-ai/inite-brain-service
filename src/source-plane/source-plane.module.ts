import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentsModule } from '../documents/documents.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { IngestModule } from '../ingest/ingest.module';
import { SourcesModule } from '../sources/sources.module';
import { AdminSourceConnectionsController } from './admin-source-connections.controller';
import { SOURCE_CONNECTORS, type Connector } from './connector';
import { FsConnector } from './connectors/fs.connector';
import { SourceConnectionService } from './source-connection.service';
import { SourceDoorsService } from './source-doors.service';
import { SourceGonePolicyService } from './source-gone-policy.service';
import { SourceItemEffectsService } from './source-item-effects.service';
import { SourceItemIngestService } from './source-item-ingest.service';
import { SourceItemService } from './source-item.service';
import { SourceSyncQueueService } from './source-sync-queue.service';
import { SourceSyncService } from './source-sync.service';

/**
 * The source plane (docs/roadmap/raw-evidence-sources-2026-09.md, W0):
 * connections, the catalogue, the sync engine and its jobs plumbing,
 * and the operator surface. Connectors are PLATFORM code registered in
 * the SOURCE_CONNECTORS array (the EVIDENCE_PROCESSOR_ADAPTERS mold):
 * `fs` (W1, behind SOURCE_KIND_FS + the SOURCE_FS_ROOTS jail); s3 / url
 * / webdav follow, then `mcp` (W2). A kind whose switch is off is "not
 * installed" to the engine: a connection of it records a failed sync
 * with "no installed connector", never a crash.
 *
 * Everything is dark behind SOURCE_PLANE_ENABLED (default off): routes
 * answer 404, no job handler registers, the scheduler enqueues nothing.
 */
@Module({
  imports: [AuthModule, DocumentsModule, EvidenceModule, IngestModule, SourcesModule],
  controllers: [AdminSourceConnectionsController],
  providers: [
    FsConnector,
    {
      provide: SOURCE_CONNECTORS,
      useFactory: (fs: FsConnector): Connector[] => [fs],
      inject: [FsConnector],
    },
    SourceConnectionService,
    SourceItemService,
    SourceDoorsService,
    SourceGonePolicyService,
    SourceItemIngestService,
    SourceItemEffectsService,
    SourceSyncService,
    SourceSyncQueueService,
  ],
  exports: [SourceConnectionService, SourceItemService, SourceSyncService, SOURCE_CONNECTORS],
})
export class SourcePlaneModule {}
