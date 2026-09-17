import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentsModule } from '../documents/documents.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { IngestModule } from '../ingest/ingest.module';
import { SourcesModule } from '../sources/sources.module';
import { AdminSourceConnectionsController } from './admin-source-connections.controller';
import { AgentRunService } from './agent-run.service';
import { AgentSourceConnectionsController } from './agent-source-connections.controller';
import { AgentSyncService } from './agent-sync.service';
import { SOURCE_CONNECTORS, type Connector } from './connector';
import { FsConnector } from './connectors/fs.connector';
import { McpConnector } from './connectors/mcp.connector';
import { S3Connector } from './connectors/s3.connector';
import { UrlConnector } from './connectors/url.connector';
import { SourceCatalogService } from './source-catalog.service';
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
 * `fs` (SOURCE_KIND_FS + the SOURCE_FS_ROOTS jail), `url` (SOURCE_KIND_URL,
 * every hop through the egress guard), `s3` (SOURCE_KIND_S3), `mcp`
 * (SOURCE_KIND_MCP — the harvester, W2: an MCP server's resources);
 * webdav follows. A kind whose switch is off is "not
 * installed" to the engine: a connection of it records a failed sync
 * with "no installed connector", never a crash.
 *
 * Everything is dark behind SOURCE_PLANE_ENABLED (default off): routes
 * answer 404, no job handler registers, the scheduler enqueues nothing.
 */
@Module({
  imports: [AuthModule, DocumentsModule, EvidenceModule, IngestModule, SourcesModule],
  controllers: [AdminSourceConnectionsController, AgentSourceConnectionsController],
  providers: [
    FsConnector,
    UrlConnector,
    S3Connector,
    McpConnector,
    {
      provide: SOURCE_CONNECTORS,
      useFactory: (...connectors: Connector[]): Connector[] => connectors,
      inject: [FsConnector, UrlConnector, S3Connector, McpConnector],
    },
    SourceCatalogService,
    SourceConnectionService,
    SourceItemService,
    SourceDoorsService,
    SourceGonePolicyService,
    SourceItemIngestService,
    SourceItemEffectsService,
    SourceSyncService,
    SourceSyncQueueService,
    AgentSyncService,
    AgentRunService,
  ],
  exports: [SourceConnectionService, SourceItemService, SourceSyncService, SOURCE_CONNECTORS],
})
export class SourcePlaneModule {}
