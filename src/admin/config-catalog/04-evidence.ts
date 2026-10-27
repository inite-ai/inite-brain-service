import type { ConfigCatalogSpec } from '../config-catalog.data';

/** Rows 1648–2342 of the catalogue, in order (see config-catalog.data.ts). */
export const CATALOG_PART_04: ConfigCatalogSpec[] = [
  // ── Evidence plane (Brain v2.1) ──
  {
    key: 'EVIDENCE_SUBSTRATE_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Master switch for the multimodal evidence substrate writers (evidence_asset / evidence_fragment / derived_representation, migration 0109). On by default. Off = EvidenceStoreService refuses every write (503) and no row is ever written; GDPR cascade + retention sweep run regardless so rows written while on stay erasable.',
  },
  {
    key: 'EVIDENCE_INGEST_ENABLED',
    category: 'pipeline',
    defaultValue: '1',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Evidence ingest surface (Brain v2.1 M3): POST /v1/ingest/evidence-asset. On by default — the surface needs no storage adapter and no other configuration. Off = the route answers a bare 404 (scenes-surface precedent). Metadata-only by design (MM-6 boundary): originUri required, storageRef rejected, no bytes accepted. Requires EVIDENCE_SUBSTRATE_ENABLED — ingest-on/substrate-off answers 503 from the write seam and env-validation warns at boot.',
  },
  {
    key: 'EVIDENCE_BLOB_UPLOAD_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence blob upload surface (Brain v2.1 MM-7): POST /v1/ingest/evidence-blob (multipart/form-data) — the ONE route that takes bytes into custody. Bytes land in the content-addressed storage adapter (needs EVIDENCE_FS_ROOT), the server computes byteHash/byteLength itself, and the asset registers blob-backed with availability derived as 'hot'. Registers with origin 'external_ingest', so it ALSO requires EVIDENCE_QUARANTINE (503 otherwise — bytes over HTTP are external ingest; no external bytes without the scan seam) plus EVIDENCE_SUBSTRATE_ENABLED. The upload is scanned before it becomes dispatchable (clean → 201, rejected → 422 with the row tombstoned and the blob deleted, hook failure → 201 with the asset left quarantined and dispatch-denied). An optional packId fires a FIRE-AND-FORGET broker dispatch when EVIDENCE_PROCESSOR_BROKER is on. Media types are an explicit conservative allowlist checked against the declared modality (no SVG, no HTML, no archives, no octet-stream); transfer is capped at min(EVIDENCE_MAX_BYTES, a 64 MiB memory-storage ceiling). Off (default) = the route answers a bare 404 BEFORE the multipart body is parsed — byte-identical prod, and no caller bytes are ever buffered.",
  },
  {
    key: 'EVIDENCE_FS_ROOT',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Directory root for the fs:// evidence storage adapter (<root>/<companyId>/<hash[0..1]>/<hash>). NO default on purpose — unset means the adapter throws a clear unconfigured error instead of silently accumulating tenant media in an unmanaged path. Local disk: correct only for ONE replica or a volume every replica mounts — with per-pod roots a blob uploaded through one pod is a 404 on the others (select EVIDENCE_STORAGE_SCHEME=s3 for a shared store).',
  },
  {
    key: 'EVIDENCE_STORAGE_SCHEME',
    category: 'pipeline',
    defaultValue: 'fs',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Which blob adapter NEW evidence uploads land in, and which one /ready and the evidence_store capability probe exercise: fs (default — local disk, unchanged behaviour) or s3 (the shared object store every replica sees; needs EVIDENCE_S3_BUCKET at boot or validation refuses). Reads resolve by each row’s own storageRef scheme, so a store switched fs→s3 keeps serving its fs:// rows. Read per call, but a flip can only select an adapter that was REGISTERED at boot.',
  },
  {
    key: 'EVIDENCE_S3_BUCKET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Bucket for the s3:// evidence storage adapter (object key <EVIDENCE_S3_PREFIX>/<companyId>/<byteHash>). Setting it REGISTERS the s3 adapter at boot; unset = the adapter does not exist and a deployment that never mentions S3 has nothing that could throw. The client is built on first use and kept — restart to change. Readiness runs a HeadBucket against it while s3 is the selected scheme.',
  },
  {
    key: 'EVIDENCE_S3_ENDPOINT',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'http(s) endpoint of an S3-compatible store (MinIO, Ceph RGW, R2, …). Unset = the AWS regional endpoint for EVIDENCE_S3_REGION. Restart to change.',
  },
  {
    key: 'EVIDENCE_S3_REGION',
    category: 'pipeline',
    defaultValue: 'us-east-1',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Signing region for the s3 adapter. us-east-1 is what MinIO-class hosts expect; set the real region for AWS. Restart to change.',
  },
  {
    key: 'EVIDENCE_S3_PREFIX',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Key namespace inside the bucket (<prefix>/<companyId>/<byteHash>; surrounding slashes stripped) so one bucket can host several environments. Empty = the bucket root. NOT part of the storageRef, so moving the prefix is configuration, not a row rewrite — but rows written under the old prefix are then unreachable until it is restored. Restart to change.',
  },
  {
    key: 'EVIDENCE_S3_ACCESS_KEY_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: false,
    isBooleanFlag: false,
    description:
      'Static credential for the s3 adapter — set together with EVIDENCE_S3_SECRET_ACCESS_KEY (validation refuses one without the other). Both unset = the SDK default credential chain (instance role, AWS_* env, profile). Restart to change.',
  },
  {
    key: 'EVIDENCE_S3_SECRET_ACCESS_KEY',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: false,
    isBooleanFlag: false,
    secret: true,
    description:
      'The secret half of the static credential pair for the s3 adapter. Masked here; never logged, never part of a probe message. Restart to change.',
  },
  {
    key: 'EVIDENCE_S3_FORCE_PATH_STYLE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: false,
    // Boolean-valued, and labelled so: the flag budget scopes itself to
    // the ENGINE_ prefixes, so the honest label costs nothing there.
    isBooleanFlag: true,
    description:
      'Path-style addressing (https://host/bucket/key) instead of virtual-hosted (https://bucket.host/key) for the s3 adapter. MinIO-class hosts need 1; AWS S3 wants 0. Store configuration, not an engine fork: boot hard-errors on a value outside 1/0/true/false rather than letting it read as OFF. Restart to change.',
  },
  {
    key: 'EVIDENCE_MAX_BYTES',
    category: 'pipeline',
    defaultValue: '1073741824',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Sanity cap on the DECLARED byteLength of a registered evidence asset (default 1 GiB). It is also the transfer bound of the blob upload surface (EVIDENCE_BLOB_UPLOAD_ENABLED), applied there as min(this, a 64 MiB memory-storage ceiling) — raising it past that ceiling raises nothing.',
  },
  {
    key: 'EVIDENCE_PROCESSOR_BROKER',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Trusted processor broker (migration 0121): dispatch platform-owned processor adapters over registered evidence assets, each execution recorded as an idempotent processing_run row (deterministic id + INSERT IGNORE — replay collides and no-ops). Requires EVIDENCE_SUBSTRATE_ENABLED. Off (default) = dispatch 503s before any query is issued and no row is ever written — byte-identical.',
  },
  {
    key: 'EVIDENCE_DOCUMENT_BRIDGE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Evidence → document bridge: when a processor run leaves a `document` asset with an asset-level `text` representation (PDF text extraction today), the broker enqueues one `evidence_document_bridge` job per (asset, representation) and the documents module ingests that text through the ordinary document pipeline (kind 'evidence_text', the asset's own vertical/recorder/occurredAt/userId, `source.meta.evidence_bridge = true`, an `evidenceAssetId` provenance hop onto every committed fact's evidence[]). Replayed runs enqueue too, so the operator dispatch sweep doubles as the backfill; the job dedupKey, the document contentHash UNIQUE and the indexer_run ledger keep it idempotent. Requires EVIDENCE_PROCESSOR_BROKER, DOCUMENT_INGEST_ENABLED and the jobs queue. Off (default) = no job is ever enqueued — byte-identical; without it an uploaded PDF yields fragments for retrieval but never a single fact.",
  },
  {
    key: 'SOURCE_PLANE_ENABLED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "Source plane master switch (docs/roadmap/raw-evidence-sources-2026-09.md, W0): the operator surface /v1/admin/source-connections (create a connection for a pack's declared `sources` entry, list its catalogue, sync now), the sync engine's `source_sync` job handler and the 5-minute scheduler that enqueues due connections. A connection runs a platform connector (`native`), harvests an MCP server (`mcp`, W2) or is a catalogue a publisher fills (`external`); what it fetches enters the existing door for its shape (document → ingest/document, conversation → ingest/mention, binary → evidence-blob, structure → the record envelope). Off (default) = the routes answer a bare 404, no handler is registered, nothing is ever enqueued and no connector ever runs — byte-identical. The handler registration is read at boot; the admin verbs and sync-now read the flag per call.",
  },
  {
    key: 'SOURCE_KIND_FS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `fs` source connector (source plane, W1): a directory on the brain host's filesystem — a mounted volume, an OS-mounted network share, the laptop a fully-local brain runs on — read as documents (text-like files) or handed to the evidence plane (PDFs, images) per the pack's source entry (file_memory: `folder` / `folder_media`). Every run is a full walk (no change feed): mtime + size is the revision, symlinks are never followed, hidden entries and VCS/build directories are skipped, maxFiles / maxFileBytes bound the walk. Requires SOURCE_PLANE_ENABLED and a SOURCE_FS_ROOTS jail. Off (default) = the connector is 'not installed': a connection of it cannot be created and an existing one records a failed sync — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_URL',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `url` source connector (source plane, W1): pages named outright and every page a sitemap lists (indexes followed one level), reduced to text (HTML stripped) or handed to the evidence plane as PDFs per the pack's source entry (web_memory: `site` / `site_media`). Every request — the first and every redirect hop — passes the SSRF egress guard; robots.txt Disallow rules are honoured per host; sameHostOnly keeps a sitemap from enumerating another host; the revision is the sitemap lastmod, else the server's ETag / Last-Modified (one HEAD per URL per run), else a time bucket. Private hosts need SOURCE_EGRESS_ALLOW_PRIVATE AND the connection's allowPrivate. Off (default) = the connector is 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_S3',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `s3` source connector (source plane, W1): objects under a prefix of an S3 or S3-compatible bucket (MinIO, R2, B2, GCS interop) through the SDK the evidence adapter already uses — text-like objects as documents, PDFs/images to the evidence plane (file_memory: `bucket` / `bucket_media`). ListObjectsV2 every run, the ETag as revision. Credential `accessKeyId:secretAccessKey`, else the SDK's default provider chain; a custom endpoint passes the egress guard (private ones need the double opt-in). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_MCP',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `mcp` source connector (source plane, W2) — the harvester: an MCP server's resources read as a source over Streamable HTTP. `resources/list` is the catalogue (re-walked every run; a resource the listing no longer carries is gone), `resources/read` the fetch, `annotations.lastModified` the revision (else a refetchHours time bucket + content-hash dedup). A pack declares the entry, pinning the server's URL (publisher-operated, `auth: install_secret` = the pack's install secret as bearer) or leaving it to the operator (`config.url`, egress-guarded at create; web_memory: `mcp_resources` / `mcp_resources_media`). Every request leaves through the egress guard; redirects are never followed; private hosts need the double opt-in. The server supplies DATA only — never tools or prompts. Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_GDRIVE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `gdrive` source connector (source plane, W4): a Google Drive folder — My Drive, a folder, a shared drive, optionally what is shared with the account — read as documents (text-like files; Docs / Sheets / Slides exported as text) or handed to the evidence plane (PDFs, office documents, images; native documents exported as OOXML) per the pack's source entry (file_memory: `gdrive` / `gdrive_media`). A full run walks the folder breadth-first through the Drive v3 API; later runs read the changes feed from the checkpointed page token. Runs as a connected Google account (SOURCE_OAUTH_CLIENT, credential `oauth:<grant id>`). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_ONEDRIVE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `onedrive` source connector (source plane, W4): a OneDrive folder or a SharePoint document library — the account's own drive, a drive by id, or a site's default library — read as documents or handed to the evidence plane (file_memory: `onedrive` / `onedrive_media`). Microsoft Graph's delta query is both the first walk and the change feed (the delta link is the checkpoint; an expired one restarts the walk). Bytes come from the item's pre-authenticated download URL, fetched without the bearer. Runs as a connected Microsoft account (SOURCE_OAUTH_CLIENT). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_DROPBOX',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `dropbox` source connector (source plane, W4): a Dropbox folder read recursively as documents or handed to the evidence plane (file_memory: `dropbox` / `dropbox_media`). The folder cursor is the change feed (`list_folder/continue` from the checkpointed cursor returns only what changed; a cursor Dropbox reset restarts the walk); `rev` is the revision. Runs as a connected Dropbox account (SOURCE_OAUTH_CLIENT). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_NOTION',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `notion` source connector (source plane, W4.5 — a wiki): the pages a connected Notion integration can see (web_memory: `notion`) — `POST /v1/search` as the catalogue (newest edit first, last_edited_time the revision), the page's block tree rendered markdown-like with a database row's properties as lines above it; `rootPageIds` narrows the walk to subtrees (child pages followed). An incremental run stops at the checkpoint; a full run walks everything and what search no longer lists is gone. Runs as a connected Notion workspace (SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_NOTION_CLIENT_ID). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_CONFLUENCE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `confluence` source connector (source plane, W4.5 — a wiki): the pages (and blog posts when asked) of a Confluence Cloud site the connected Atlassian account reaches (web_memory: `confluence`), through the v2 REST API at api.atlassian.com/ex/confluence/<cloud id> — the site from accessible-resources (`config.site` names one of several), `spaceKeys` narrows the walk, the listing newest modification first (an incremental run stops at the checkpoint), the version number the revision, storage-format XHTML reduced to text. Runs as a connected Atlassian account (SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_ATLASSIAN_CLIENT_ID). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_GMAIL',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `gmail` source connector (source plane, W4.6 — mail): a Gmail mailbox through the Gmail REST API as a connected Google account (gmail.readonly; the brain never labels or deletes). One catalogue row per message (its id is its revision), `messages.list` with the connection's own Gmail query plus `after:<since>` (the operator's date on a first walk, the checkpoint's walk time less a day on an incremental one), newest first, capped by `maxMessages`; deletions from the history feed. A message is fetched raw and enters the mention door as ONE TURN of its thread (mail_memory: `gmail`) — sender as the speaker, quoted replies and signatures stripped, attachments named; the `gmail_attachments` entry hands the attachments themselves to the evidence plane. Runs as a connected Google account (SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_GOOGLE_CLIENT_ID). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_IMAP',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `imap` source connector (source plane, W4.6 — mail): any mailbox over IMAP — a host, a user and the mailbox password (an app password) as the credential, TLS on 993 (a plain socket only under the private opt-in), read-only: greeting, LOGIN, EXAMINE, UID SEARCH, UID FETCH, LOGOUT and nothing else (no STARTTLS, no IDLE, no OAuth over IMAP). One row per message, the Message-ID its id and revision, the RFC 5092 URL its origin; a first walk reads `SINCE <since>` (the newest `maxMessages` per mailbox), an incremental run only what is above the checkpoint's highest UID, a mailbox whose UIDVALIDITY moved is walked again; a full walk finds what was deleted. A message enters the mention door as one turn of the thread its References name (mail_memory: `imap`). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_PIPEDRIVE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `pipedrive` source connector (source plane, W4.2 — the first CRM on the records contract, docs/roadmap/crm-sources-2026-09.md): deals, persons and organizations of a Pipedrive account through API v2 (`updated_since` + cursor per entity, stage / pipeline / owner ids resolved to names once per run), as a connected account (SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_PIPEDRIVE_CLIENT_ID) or with an API token. Every record enters the records door: its mapped attributes become facts deterministically (crm_memory), the record's own id is the entity's identity, a changed value supersedes the old one, a record gone at the source closes them. Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_OAUTH_PIPEDRIVE_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The client id of the Pipedrive app the brain connects Pipedrive accounts through (Marketplace Manager; the brain's callback URL as its OAuth callback; scopes set on the app). Unset = Pipedrive is 'not configured' — an API token still works as the connection's credential.",
  },
  {
    key: 'SOURCE_OAUTH_PIPEDRIVE_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'The client secret of the Pipedrive app named by SOURCE_OAUTH_PIPEDRIVE_CLIENT_ID (sent as HTTP Basic to its token endpoint).',
  },
  {
    key: 'SOURCE_OAUTH_PIPEDRIVE_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the Pipedrive (OAuth + API) counterpart.',
  },
  {
    key: 'SOURCE_KIND_HUBSPOT',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `hubspot` source connector (source plane, W4.2b — a CRM on the records contract, docs/roadmap/crm-sources-2026-09.md): deals, contacts and companies of a HubSpot portal through the CRM v3 Search API (one query per object sorted by last-modified, `GTE since` for the incremental walk, `after` cursor, the 10 000-result cap narrowed into windows; associations batch-read per page; owners / deal pipelines / lifecycle stages resolved to labels once per run), as a connected account (SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_HUBSPOT_CLIENT_ID; scopes crm.objects.{deals,contacts,companies,owners}.read) or with a private-app access token. Records enter the records door (crm_memory). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_OAUTH_HUBSPOT_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The client id of the HubSpot app the brain connects HubSpot accounts through (a public app in the developer account; the brain's callback URL as its redirect URL; the app's scopes must include the ones the connector asks). Unset = HubSpot is 'not configured' — a private-app access token still works as the connection's credential.",
  },
  {
    key: 'SOURCE_OAUTH_HUBSPOT_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description: 'The client secret of the HubSpot app named by SOURCE_OAUTH_HUBSPOT_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_HUBSPOT_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the HubSpot (OAuth + API) counterpart.',
  },
  {
    key: 'SOURCE_KIND_BITRIX24',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `bitrix24` source connector (source plane, W4.2b — a CRM on the records contract): deals, leads, contacts and companies of a Bitrix24 portal through `crm.item.list` / `crm.item.get` (one entityTypeId per entity; `filter[>updatedTime]` + `start` offset for the incremental walk; stages / statuses / sources / industries resolved through crm.status.list, pipelines through crm.category.list, responsible users through user.get when the webhook has the `user` scope). Runs as a CONNECTED ACCOUNT (W4.3b: SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_BITRIX24_CLIENT_ID — a local / Marketplace application; the portal from the grant's `client_endpoint`, the token as `auth` + bearer, refreshed by the engine) or on an INBOUND WEBHOOK URL the portal admin makes (`https://<portal>/rest/<user>/<code>/`, scope crm) — stored encrypted, never echoed. A self-hosted portal on the LAN needs the double opt-in (`config.allowPrivate` + SOURCE_EGRESS_ALLOW_PRIVATE). Records enter the records door (crm_memory). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_KOMMO',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `kommo` source connector (source plane, W4.2b — a CRM on the records contract): leads (deals), contacts and companies of a Kommo / amoCRM account through API v4 (`filter[updated_at][from]` + `page`, 250 a page, `with=contacts`; pipelines / statuses / users / loss reasons resolved to names once per run; the account currency on every lead). Runs as a CONNECTED ACCOUNT (W4.3b: SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_KOMMO_CLIENT_ID — an integration of the operator's; the account's host from the callback's `referer`, the 24-hour token refreshed there by the engine) or on a LONG-LIVED TOKEN of a private integration (a bearer) with `config.baseUrl` naming the account (`https://<subdomain>.kommo.com` / `.amocrm.ru`; it overrides the grant's host when both are given). Records enter the records door (crm_memory). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_KIND_SALESFORCE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `salesforce` source connector (source plane, W4.2c — a CRM on the records contract, docs/roadmap/crm-sources-2026-09.md § 4.2.1): opportunities, contacts, accounts, leads and cases of a Salesforce org through SOQL over REST (one query per object ordered by LastModifiedDate, `LastModifiedDate > since` for the incremental walk, `nextRecordsUrl` paging; owner / account names as relationship fields; the deleted-ids feed closes what was deleted since the checkpoint), Bulk API 2.0 for a large org's first walk when the connection asks (`config.bulk`). Runs as a connected account (SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_SALESFORCE_CLIENT_ID; scope `api`; the org from the grant's `instance_url`, `config.instanceUrl` overrides) or as an integration user through a JWT bearer (the credential is a JSON { clientId, username, privateKey, loginUrl? }; no browser, no refresh token). Records enter the records door (crm_memory). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_OAUTH_SALESFORCE_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The consumer key of the Salesforce connected app the brain connects orgs through (OAuth web server flow with PKCE; the brain's callback URL as its callback URL; scopes api, refresh_token, openid). Unset = Salesforce is 'not configured' — a JWT bearer credential still works.",
  },
  {
    key: 'SOURCE_OAUTH_SALESFORCE_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'The consumer secret of the Salesforce connected app named by SOURCE_OAUTH_SALESFORCE_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_SALESFORCE_LOGIN_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The Salesforce login host for the connected-account flow: unset = https://login.salesforce.com; https://test.salesforce.com for a sandbox, or the org's My Domain login URL. Swaps the origin of the authorize / token / identity URLs (public https only — not the dev override). A JWT bearer credential names its own `loginUrl`.",
  },
  {
    key: 'SOURCE_OAUTH_SALESFORCE_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the Salesforce (login host + org API) counterpart.',
  },
  {
    key: 'SOURCE_OAUTH_BITRIX24_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The client id (`app.…`) of the Bitrix24 application the brain connects portals through — a local application on one portal or a Marketplace one, with the brain's callback URL as its handler path and the `crm` + `user` scopes. The flow is Bitrix24's 'full' authorization: oauth.bitrix.info asks which portal, the token endpoint (a GET) answers the portal's REST root, refresh tokens live 28 days. Unset = Bitrix24 is 'not configured' — an inbound webhook URL still works.",
  },
  {
    key: 'SOURCE_OAUTH_BITRIX24_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'The client secret of the Bitrix24 application named by SOURCE_OAUTH_BITRIX24_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_BITRIX24_LOGIN_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The portal's own origin (https://<portal>.bitrix24.ru) for a local application on one portal: the consent opens on the portal instead of the oauth.bitrix.info portal prompt and the token endpoint is the portal's. Unset = oauth.bitrix.info (any portal the user picks). Public https only — not the dev override.",
  },
  {
    key: 'SOURCE_OAUTH_BITRIX24_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the Bitrix24 (oauth.bitrix.info + portal REST) counterpart.',
  },
  {
    key: 'SOURCE_OAUTH_KOMMO_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The integration id of the Kommo / amoCRM integration the brain connects accounts through (an integration in the operator's account with the brain's callback URL as its redirect URI). The callback names the account's host (`referer`), the token endpoint lives there and takes JSON, refresh tokens rotate on every use (24 h access, 3 months refresh). Unset = Kommo is 'not configured' — a long-lived token still works.",
  },
  {
    key: 'SOURCE_OAUTH_KOMMO_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'The secret key of the Kommo / amoCRM integration named by SOURCE_OAUTH_KOMMO_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_KOMMO_LOGIN_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'The consent host: unset = https://www.kommo.com; https://www.amocrm.ru for amoCRM accounts. Public https only — not the dev override. The token endpoint is on the account’s own host either way.',
  },
  {
    key: 'SOURCE_OAUTH_KOMMO_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the Kommo (consent host + account API) counterpart.',
  },
  {
    key: 'SOURCE_OAUTH_NOTION_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The OAuth client id of the PUBLIC Notion integration the brain connects workspaces through (the brain's callback URL as its redirect URI; read-content and read-user capabilities). Notion's token endpoint takes the app's credentials as HTTP Basic and a JSON body, issues no refresh token (the token never expires) and knows no PKCE. Unset = Notion is 'not configured'.",
  },
  {
    key: 'SOURCE_OAUTH_NOTION_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'The OAuth client secret of the Notion integration named by SOURCE_OAUTH_NOTION_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_NOTION_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the Notion (OAuth + API) counterpart.',
  },
  {
    key: 'SOURCE_OAUTH_ATLASSIAN_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The client id of the Atlassian OAuth 2.0 (3LO) app the brain connects Confluence Cloud sites through (developer.atlassian.com; the brain's callback URL as its callback; the Confluence scopes read:page:confluence, read:space:confluence, read:blogpost:confluence and offline_access). The token endpoint takes JSON with the app's credentials in the body; refresh tokens rotate. Unset = Atlassian is 'not configured'.",
  },
  {
    key: 'SOURCE_OAUTH_ATLASSIAN_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'The client secret of the Atlassian app named by SOURCE_OAUTH_ATLASSIAN_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_ATLASSIAN_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the Atlassian (auth.atlassian.com + api.atlassian.com) counterpart.',
  },
  {
    key: 'SOURCE_KIND_GITHUB',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `github` source connector (source plane, W4.8 — the forge): one GitHub repository over the REST API, as a connected GitHub account (SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_GITHUB_CLIENT_ID) or with a token that can read it. Two shapes of the same repository (code_memory): `github_issues` — every issue and pull request as one conversation (body + every comment, each speaking as its author, `updated_at` the revision) through the mention door; `github_docs` — the text files of the default branch (or `ref`) from one recursive tree call, the blob sha the revision, judged by the same media table as a folder. Read-only: the brain never comments, labels or closes. A GitHub Enterprise host is reached with `config.baseUrl` (+ `allowPrivate` for a host inside the network). Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_OAUTH_GITHUB_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The client id of the GitHub OAuth app the brain connects accounts through (github.com/settings/developers; the brain's callback URL as the authorization callback; the `repo` scope for private repositories). The token endpoint is a form that answers JSON when asked, the token does not expire, there is no PKCE. Unset = GitHub is 'not configured' — a token can still be pasted as the credential.",
  },
  {
    key: 'SOURCE_OAUTH_GITHUB_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description: 'The client secret of the GitHub app named by SOURCE_OAUTH_GITHUB_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_GITHUB_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the GitHub (github.com OAuth + api.github.com) counterpart. A GitHub Enterprise deployment is named per connection (`config.baseUrl`), not here.',
  },
  {
    key: 'SOURCE_LINKED',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The linked lane (source plane, W7): a connection in `mode: 'linked'` is never walked and never catalogued — its connector's `search()` is called at QUERY time and the hits ride beside the ranking in the search response's `linked` section, never mixed into `results` (another system's opinion is not this brain's memory, and mixing them would make a citation mean two things). Every call writes a content-free `tool_observation` (0111) and the hits carry its ref, so a document made of them — and every fact derived from that document — points back at the call that produced it; a hit whose observation could not be written is NOT served, which is why this also needs TOOL_OBSERVATIONS_ENABLED. Bounded because it is a network call on the query path: one round per connection (25 connections at most), `SOURCE_LINKED_PER_QUERY` hits each, an 8s deadline, and every failure named rather than a failed search. A connector without `search()` says so by name. Off (default) = no connector is ever asked, no observation written, no `linked` section — byte-identical.",
  },
  {
    key: 'SOURCE_LINKED_PER_QUERY',
    category: 'pipeline',
    defaultValue: '5',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'Hits per linked connection per query (default 5, hard cap 25). The bound on how much of another system’s opinion rides along with an answer.',
  },
  {
    key: 'SOURCE_PROGRESSIVE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      'Progressive indexing (source plane, W6 — doctrine 5, "manifest always, content by policy"): a connection whose `contentPolicy` is `manifest` walks a whole drive for the price of a listing and reads nothing, until a query matches one of its catalogue rows by TITLE or PATH — then that row alone is fetched and ingested as a `source_sync` job with a `deepen` payload (`ranBy: deepen`), and the NEXT query sees the content. The probe runs after retrieval, off the answer\'s path, never changes the answer it rode in on, and never throws: a search must not fail because a catalogue read did. A hit is not a read — `hitCount` on the row is the evidence that reading would have been worth it, and only SOURCE_DEEPEN_PER_QUERY rows per query are actually fetched, so a flood of queries against a million-item drive costs counter updates, not a million fetches. A deepening reads only what the walk already catalogued: no walk, no checkpoint, no gone policy. Off (default) = no probe ever runs, no hit is ever counted — byte-identical.',
  },
  {
    key: 'SOURCE_DEEPEN_PER_QUERY',
    category: 'pipeline',
    defaultValue: '3',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'How many catalogue rows one query may send for deepening under SOURCE_PROGRESSIVE (default 3, hard cap 20). The bound that keeps "every query probes the catalogue" from meaning "every query fetches the internet".',
  },
  {
    key: 'SOURCE_PRINCIPALS',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The membership plane (source plane, W5 — G6 steps 3–5): after every sync of an ORG connection (one with no owning user), the connector's `principals()` walk runs and its groups and accounts land as `external_identity` rows and `external_principal` tuples (migration 0169), and an item's `acl.groups` become `team:<connection>:<group>` tags on the document, asset, episode and derived facts it produces. An external account NOBODY has linked to a brain user grants no visibility at all — the link is an operator's decision (`POST .../principals/link`) or an address another linked identity already carries, never a guess. Revocation is a timestamp and moves the tenant's `scope_epoch`, so a cached expansion cannot outlive the change that invalidated it (the new-enemy problem). An ACL too large to mirror is a sync ERROR, never a truncation. The READ half is SCOPE_TAGS_ENABLED: with this on and that off, tags are written and ignored — the safe order to switch the two on in. Off (default) = no `principals()` is ever called, no tuple is ever written, every org connection's rows stay tenant-global — byte-identical.",
  },
  {
    key: 'EVIDENCE_PARSER_REMOTE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The quality tier of document text (evidence plane, W6): a document-understanding SERVICE (docling, marker, unstructured, a vendor's) as the first platform processor allowed to make a network call. Every text adapter that ships is local by construction — pdf2json for a PDF's text layer, officeparser for OOXML, tesseract for pixels — and they are also the FLOOR: a PDF whose layout carries meaning comes out of a text-layer dump as prose soup. The remote adapter sits FIRST in the registry, so for the media types the operator named (EVIDENCE_PARSER_REMOTE_MEDIA_TYPES, default PDF) it wins, and for everything else the local one is untouched. The contract is ours, not a vendor's — one endpoint, `POST { mediaType, profile?, contentBase64 }` → `{ text | markdown | content }`, which a small shim the operator owns puts in front of the real parser (and where they add their own redaction before bytes leave). Every call goes through the egress guard; the bearer never appears in an error; a failure is a RUN failure, never a quiet fallthrough to the local adapter. Off (default), or the URL unset = the adapter accepts nothing and the registry is byte-identical to the local-only one.",
  },
  {
    key: 'EVIDENCE_PARSER_REMOTE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'The endpoint EVIDENCE_PARSER_REMOTE posts to. Unset = the adapter is off however the flag reads. It rides the adapter fingerprint: pointing at a different parser forks the idempotency key, so a representation made by the old one is never served as the new one.',
  },
  {
    key: 'EVIDENCE_PARSER_REMOTE_TOKEN',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description:
      'The bearer the parser service expects, when it wants one. A credential, not a knob: it never rides the fingerprint and never appears in an error message.',
  },
  {
    key: 'EVIDENCE_PARSER_REMOTE_MEDIA_TYPES',
    category: 'pipeline',
    defaultValue: 'application/pdf',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      'What the operator lets the parser service see, comma-separated. Unset = `application/pdf` only: the format whose local floor is furthest from its ceiling. A type not named here goes to the local adapter exactly as before.',
  },
  {
    key: 'EVIDENCE_PARSER_REMOTE_PROFILE',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "A label passed to the service when it has modes (docling's pipeline, a model name). It changes the OUTPUT, so it rides the adapter fingerprint: flipping it re-parses instead of serving a representation made under the old mode.",
  },
  {
    key: 'EVIDENCE_PARSER_REMOTE_ALLOW_PRIVATE',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The parser service runs inside the operator's own network: the connection half of the egress double opt-in for it (the other half is SOURCE_EGRESS_ALLOW_PRIVATE). Either alone changes nothing.",
  },
  {
    key: 'SOURCE_KIND_GITLAB',
    category: 'pipeline',
    defaultValue: '0',
    runtimeMutable: true,
    isBooleanFlag: true,
    description:
      "The `gitlab` source connector (source plane, W4.9 — the other forge): one GitLab project over the v4 API, as a connected GitLab account (SOURCE_OAUTH_CLIENT + SOURCE_OAUTH_GITLAB_CLIENT_ID) or with an access token that has `read_api` on it. Two shapes of the same project (code_memory): `gitlab_issues` — every issue AND merge request as one conversation (the description + every note, each speaking as its author, `updated_at` the revision) through the mention door, GitLab's own activity notes dropped and an issue #5 kept apart from a merge request !5; `gitlab_docs` — the text files of the default branch (or `ref`) from the recursive tree listing, the blob id the revision, judged by the same media table as a folder. Read-only. A self-managed instance is reached with `config.baseUrl` (+ `allowPrivate` for a host inside the network); connecting an ACCOUNT there is SOURCE_OAUTH_GITLAB_LOGIN_URL. Off (default) = 'not installed' — byte-identical.",
  },
  {
    key: 'SOURCE_OAUTH_GITLAB_CLIENT_ID',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The application id of the GitLab OAuth application the brain connects accounts through (gitlab.com/-/user_settings/applications, or Admin → Applications on a self-managed instance; the brain's callback URL as the redirect URI; the `read_api` scope). Standard authorization code with PKCE; the refresh token ROTATES on every use, which the engine handles. Unset = GitLab is 'not configured' — a token can still be pasted as the credential.",
  },
  {
    key: 'SOURCE_OAUTH_GITLAB_CLIENT_SECRET',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    secret: true,
    description: 'The secret of the GitLab application named by SOURCE_OAUTH_GITLAB_CLIENT_ID.',
  },
  {
    key: 'SOURCE_OAUTH_GITLAB_LOGIN_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "The self-managed GitLab the brain connects accounts on ('https://gitlab.acme.com'): its origin replaces gitlab.com on the authorize, token, identity AND API URLs together — an application registered on one instance issues tokens only that instance honours. Public https only. Unset = gitlab.com. A project on an instance the brain reads with a pasted token needs no flag: `config.baseUrl` on the connection names it.",
  },
  {
    key: 'SOURCE_OAUTH_GITLAB_BASE_URL',
    category: 'pipeline',
    defaultValue: '',
    runtimeMutable: true,
    isBooleanFlag: false,
    description:
      "Dev/test only — see SOURCE_OAUTH_GOOGLE_BASE_URL; the GitLab counterpart (one origin for the OAuth endpoints and /api/v4). A self-managed deployment is SOURCE_OAUTH_GITLAB_LOGIN_URL or a connection's `config.baseUrl`, not this.",
  },
];
