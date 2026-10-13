import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentsModule } from '../documents/documents.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { IngestModule } from '../ingest/ingest.module';
import { SourcesModule } from '../sources/sources.module';
import { AdminSourceConnectionsController } from './admin-source-connections.controller';
import { AdminSourceInspectController } from './admin-source-inspect.controller';
import { AgentRunService } from './agent-run.service';
import { AgentSourceConnectionsController } from './agent-source-connections.controller';
import { AgentSyncService } from './agent-sync.service';
import { SOURCE_CONNECTORS, type Connector } from './connector';
import { Bitrix24Connector } from './connectors/bitrix24.connector';
import { ConfluenceConnector } from './connectors/confluence.connector';
import { GmailConnector } from './connectors/gmail.connector';
import { ImapConnector } from './connectors/imap.connector';
import { GithubConnector } from './connectors/github.connector';
import { GitlabConnector } from './connectors/gitlab.connector';
import { SlackConnector } from './connectors/slack.connector';
import { TelegramConnector } from './connectors/telegram.connector';
import { DropboxConnector } from './connectors/dropbox.connector';
import { FsConnector } from './connectors/fs.connector';
import { GDriveConnector } from './connectors/gdrive.connector';
import { HubSpotConnector } from './connectors/hubspot.connector';
import { KommoConnector } from './connectors/kommo.connector';
import { McpConnector } from './connectors/mcp.connector';
import { OneDriveConnector } from './connectors/onedrive.connector';
import { PipedriveConnector } from './connectors/pipedrive.connector';
import { RestRecordsConnector } from './connectors/rest-records.connector';
import { S3Connector } from './connectors/s3.connector';
import { NotionConnector } from './connectors/notion.connector';
import { SalesforceConnector } from './connectors/salesforce.connector';
import { UrlConnector } from './connectors/url.connector';
import { AdminSourceOAuthController } from './oauth/admin-source-oauth.controller';
import { CredentialProvider } from './oauth/credential-provider';
import { OAuthClientRegistryService } from './oauth/oauth-client-registry.service';
import { SourceOAuthCallbackController } from './oauth/source-oauth-callback.controller';
import { SourceOAuthService } from './oauth/source-oauth.service';
import { AdminSourceWebhookController } from './records/admin-source-webhook.controller';
import { MappingAssistantService } from './records/mapping-assistant.service';
import { RecordsDoorService } from './records/records-door.service';
import { RecordsPreviewService } from './records/records-preview.service';
import { RecordsPushService } from './records/records-push.service';
import { RecordsWebhookService } from './records/records-webhook.service';
import { SourceWebhookController } from './records/source-webhook.controller';
import { SourceAgentService } from './source-agent.service';
import { SourceCatalogService } from './source-catalog.service';
import { SourceConnectionService } from './source-connection.service';
import { SourceDoorsService } from './source-doors.service';
import { SourceGonePolicyService } from './source-gone-policy.service';
import { SourceInspectService } from './source-inspect.service';
import { SourceItemEffectsService } from './source-item-effects.service';
import { SourceItemIngestService } from './source-item-ingest.service';
import { SourceItemService } from './source-item.service';
import { SourceRunHistoryService } from './source-run-history.service';
import { SourceSyncQueueService } from './source-sync-queue.service';
import { SourceSyncService } from './source-sync.service';

/**
 * The source plane (docs/roadmap/raw-evidence-sources-2026-09.md, W0):
 * connections, the catalogue, the sync engine and its jobs plumbing,
 * and the operator surface. Connectors are PLATFORM code registered in
 * the SOURCE_CONNECTORS array (the EVIDENCE_PROCESSOR_ADAPTERS mold):
 * `fs` (SOURCE_KIND_FS + the SOURCE_FS_ROOTS jail), `url` (SOURCE_KIND_URL,
 * every hop through the egress guard), `s3` (SOURCE_KIND_S3), `mcp`
 * (SOURCE_KIND_MCP — the harvester, W2: an MCP server's resources), and
 * the cloud drives (W4) — `gdrive` (SOURCE_KIND_GDRIVE), `onedrive`
 * (SOURCE_KIND_ONEDRIVE), `dropbox` (SOURCE_KIND_DROPBOX) — which run as
 * a connected account (SOURCE_OAUTH_CLIENT: the brain as an outbound
 * OAuth client, grants encrypted under SOURCE_CREDENTIAL_ENCRYPTION_KEY, resolved
 * through CredentialProvider at run time); the records contract (W4.2,
 * `records/`) with the CRM vendors on it — `pipedrive`
 * (SOURCE_KIND_PIPEDRIVE), `hubspot` (SOURCE_KIND_HUBSPOT), `bitrix24`
 * (SOURCE_KIND_BITRIX24), `kommo` (SOURCE_KIND_KOMMO), `salesforce`
 * (SOURCE_KIND_SALESFORCE — SOQL over REST, a connected account or a
 * JWT bearer, W4.2c), and the config-driven `rest_records`
 * (SOURCE_KIND_REST_RECORDS) the mapping assistant proposes for the
 * long tail — the records door behind every `structure` item, and the
 * inbound webhook lane (SOURCE_WEBHOOKS, W4.2c: the vendor names a
 * record, the engine fetches it through the same door); webdav
 * follows. A kind whose switch is off is "not installed" to the
 * engine: a connection of it records a failed sync with "no installed
 * connector", never a crash.
 *
 * Everything is dark behind SOURCE_PLANE_ENABLED (default off): routes
 * answer 404, no job handler registers, the scheduler enqueues nothing.
 *
 * Controller order matters: the OAuth controller's literal `oauth/…`
 * segments and the public webhook's `webhook/…` are registered before
 * the connections controllers' `:id`.
 */
@Module({
  imports: [AuthModule, DocumentsModule, EvidenceModule, IngestModule, SourcesModule],
  controllers: [
    AdminSourceOAuthController,
    AdminSourceConnectionsController,
    AdminSourceInspectController,
    AdminSourceWebhookController,
    SourceWebhookController,
    AgentSourceConnectionsController,
    SourceOAuthCallbackController,
  ],
  providers: [
    FsConnector,
    UrlConnector,
    S3Connector,
    McpConnector,
    GDriveConnector,
    OneDriveConnector,
    DropboxConnector,
    NotionConnector,
    ConfluenceConnector,
    GmailConnector,
    ImapConnector,
    GithubConnector,
    GitlabConnector,
    SlackConnector,
    TelegramConnector,
    PipedriveConnector,
    HubSpotConnector,
    Bitrix24Connector,
    KommoConnector,
    SalesforceConnector,
    RestRecordsConnector,
    {
      provide: SOURCE_CONNECTORS,
      useFactory: (...connectors: Connector[]): Connector[] => connectors,
      inject: [
        FsConnector,
        UrlConnector,
        S3Connector,
        McpConnector,
        GDriveConnector,
        OneDriveConnector,
        DropboxConnector,
        NotionConnector,
        ConfluenceConnector,
        GmailConnector,
        ImapConnector,
        GithubConnector,
        GitlabConnector,
        SlackConnector,
        TelegramConnector,
        PipedriveConnector,
        HubSpotConnector,
        Bitrix24Connector,
        KommoConnector,
        SalesforceConnector,
        RestRecordsConnector,
      ],
    },
    OAuthClientRegistryService,
    SourceOAuthService,
    CredentialProvider,
    SourceCatalogService,
    SourceAgentService,
    SourceConnectionService,
    SourceItemService,
    SourceDoorsService,
    RecordsDoorService,
    RecordsPushService,
    RecordsPreviewService,
    RecordsWebhookService,
    MappingAssistantService,
    SourceGonePolicyService,
    SourceItemIngestService,
    SourceItemEffectsService,
    SourceSyncService,
    SourceSyncQueueService,
    SourceRunHistoryService,
    SourceInspectService,
    AgentSyncService,
    AgentRunService,
  ],
  exports: [
    SourceConnectionService,
    SourceItemService,
    SourceSyncService,
    SourceOAuthService,
    SOURCE_CONNECTORS,
  ],
})
export class SourcePlaneModule {}
