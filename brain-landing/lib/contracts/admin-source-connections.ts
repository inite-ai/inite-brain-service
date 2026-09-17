import { z } from 'zod'

/**
 * Wire contracts for the source plane's operator surface
 * (/v1/admin/source-connections).
 *
 * **Duplicate** of src/contracts/source-plane/source-plane.schema.ts
 * (response shapes — requests are built by the panel and validated by
 * the backend). See admin-leases.ts for the rationale on duplication.
 * The enum lists below are exported so the panel derives its selects
 * from them (guarded by __tests__/admin-drift.test.ts).
 */

const ConnectionStatusSchema = z.enum(['active', 'paused', 'deleting'])
const ModeSchema = z.enum(['synced', 'linked'])
const ScheduleSchema = z.enum(['manual', '15m', '1h', '4h', '24h'])
const ContentPolicySchema = z.enum(['manifest', 'text', 'bytes'])
const DeletePolicySchema = z.enum(['close', 'retract', 'keep'])
const ShapeSchema = z.enum(['document', 'conversation', 'binary', 'structure'])
const KindSchema = z.enum(['mcp', 'native', 'external'])
const ItemStateSchema = z.enum(['seen', 'fetched', 'indexed', 'gone'])
const AvailabilitySchema = z.enum([
  'ready',
  'disabled',
  'missing',
  'agent',
  'external',
])

export const SOURCE_SCHEDULES = ScheduleSchema.options
export const SOURCE_CONTENT_POLICIES = ContentPolicySchema.options
export const SOURCE_DELETE_POLICIES = DeletePolicySchema.options
export const SOURCE_ITEM_STATES = ItemStateSchema.options

const OpenRecord = z.record(z.string(), z.unknown())

export const SourceConnectionSchema = z.object({
  id: z.string(),
  packId: z.string(),
  sourceId: z.string(),
  kind: KindSchema,
  connector: z.string(),
  shape: ShapeSchema,
  host: z.string(),
  label: z.string().nullable(),
  config: OpenRecord,
  hasCredential: z.boolean(),
  /** The connected account it runs as (`credential = oauth:<grant>`), else null. */
  grantId: z.string().nullable(),
  mode: ModeSchema,
  schedule: ScheduleSchema,
  contentPolicy: ContentPolicySchema,
  deletePolicy: DeletePolicySchema,
  fetchBudget: z.number().int().nullable(),
  status: ConnectionStatusSchema,
  checkpoint: OpenRecord.nullable(),
  vertical: z.string(),
  recorder: z.string(),
  sourceKey: z.string(),
  ownerUserId: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
})

export const SourceConnectionsListResponseSchema = z.object({
  connections: z.array(SourceConnectionSchema),
})

export const SourceItemSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  externalId: z.string(),
  originUri: z.string().nullable(),
  path: z.string().nullable(),
  title: z.string().nullable(),
  mediaType: z.string().nullable(),
  size: z.number().int().nullable(),
  revision: z.string().nullable(),
  fetchedRevision: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  documentId: z.string().nullable(),
  assetId: z.string().nullable(),
  episodeId: z.string().nullable(),
  state: ItemStateSchema,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  goneAt: z.string().nullable(),
  lastError: z.string().nullable(),
})

export const SourceItemsListResponseSchema = z.object({
  items: z.array(SourceItemSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
})

export const SourceSyncSummarySchema = z.object({
  connectionId: z.string(),
  mode: z.enum(['full', 'incremental']),
  status: z.enum(['succeeded', 'failed', 'skipped']),
  skipped: z.string().optional(),
  seen: z.number().int(),
  new: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
  gone: z.number().int(),
  fetched: z.number().int(),
  ingested: z.number().int(),
  deduplicated: z.number().int(),
  failed: z.number().int(),
  closed: z.number().int(),
  durationMs: z.number().int(),
  error: z.string().optional(),
})

export const SyncNowResponseSchema = z.union([
  z.object({
    enqueued: z.literal(true),
    runId: z.string(),
    created: z.boolean(),
  }),
  z.object({ enqueued: z.literal(false), summary: SourceSyncSummarySchema }),
])

export const DeleteConnectionResponseSchema = z.object({
  deleted: z.literal(true),
  items: z.number().int(),
})

export const SourceCatalogEntrySchema = z.object({
  packId: z.string(),
  packVersion: z.string(),
  builtin: z.boolean(),
  accepted: z.boolean(),
  sourceId: z.string(),
  kind: KindSchema,
  connector: z.string(),
  shape: ShapeSchema,
  title: z.string().nullable(),
  description: z.string().nullable(),
  defaults: z.object({
    contentPolicy: ContentPolicySchema,
    deletePolicy: DeletePolicySchema,
    schedule: ScheduleSchema,
  }),
  availability: AvailabilitySchema,
  configExample: OpenRecord.nullable(),
  credentialHint: z.string().nullable(),
  hosts: z.array(z.enum(['server', 'agent'])),
  mcp: z
    .object({
      transport: z.enum(['http', 'stdio']),
      url: z.string().nullable(),
      auth: z.enum(['none', 'install_secret', 'oauth']).nullable(),
      command: z.string().nullable(),
      args: z.array(z.string()),
    })
    .nullable(),
  /** The connector runs as a connected account: which provider, the scopes, whether an app is registered here. */
  oauth: z
    .object({
      provider: z.string(),
      title: z.string(),
      scopes: z.array(z.string()),
      configured: z.boolean(),
    })
    .nullable(),
})

export const SourceConnectorStateSchema = z.object({
  kind: z.string(),
  state: z.enum(['ready', 'disabled']),
  flag: z.string(),
})

export const SourceCatalogResponseSchema = z.object({
  sources: z.array(SourceCatalogEntrySchema),
  connectors: z.array(SourceConnectorStateSchema),
  fsRoots: z.array(z.string()),
  egressAllowPrivate: z.boolean(),
})

// ── Inspection (the operator's drill-down) ─────────────────────────────

export const SourceConnectionStatsSchema = z.object({
  connectionId: z.string(),
  items: z.object({
    seen: z.number().int(),
    fetched: z.number().int(),
    indexed: z.number().int(),
    gone: z.number().int(),
    total: z.number().int(),
  }),
  facts: z
    .object({
      active: z.number().int(),
      stale: z.number().int(),
      closed: z.number().int(),
    })
    .nullable(),
})

export const SourceRunCountersSchema = z.object({
  seen: z.number().int(),
  new: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
  gone: z.number().int(),
  fetched: z.number().int(),
  ingested: z.number().int(),
  deduplicated: z.number().int(),
  failed: z.number().int(),
  closed: z.number().int(),
})

export const SourceRunSchema = z.object({
  runId: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'pending']),
  ranBy: z.string(),
  triggeredBy: z.enum(['cron', 'manual', 'startup']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  mode: z.enum(['full', 'incremental']).nullable(),
  counters: SourceRunCountersSchema.nullable(),
  skipped: z.string().nullable(),
  error: z.string().nullable(),
})

export const SourceRunsResponseSchema = z.object({
  connectionId: z.string(),
  persisted: z.boolean(),
  runs: z.array(SourceRunSchema),
})

export const SourceItemFactSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number(),
  version: z.string().nullable(),
  staleAt: z.string().nullable(),
  staleReason: z.string().nullable(),
  validUntil: z.string().nullable(),
  status: z.string(),
})

export const SourceItemDocumentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  status: z.string().nullable(),
  originUri: z.string().nullable(),
  createdAt: z.string().nullable(),
})

export const SourceItemAssetSchema = z.object({
  id: z.string(),
  mediaType: z.string(),
  modality: z.string(),
  byteLength: z.number().int(),
  availability: z.string(),
  quarantineStatus: z.string().nullable(),
  representations: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      producerVersion: z.string(),
      chars: z.number().int(),
      createdAt: z.string().nullable(),
    }),
  ),
})

export const SourceItemInspectResponseSchema = z.object({
  item: SourceItemSchema,
  documents: z.array(SourceItemDocumentSchema),
  asset: SourceItemAssetSchema.nullable(),
  facts: z.array(SourceItemFactSchema),
  factsTruncated: z.boolean(),
})

// ── Agents' presence and the folder picker ────────────────────────────

export const SourceAgentSchema = z.object({
  agentId: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  version: z.string().nullable(),
  hostname: z.string().nullable(),
  platform: z.string().nullable(),
  roots: z.array(z.object({ path: z.string(), folders: z.array(z.string()) })),
})
export const SourceAgentsResponseSchema = z.object({ agents: z.array(SourceAgentSchema) })

// ── Connected accounts (W4) ──────────────────────────────────────────

export const SourceOAuthProviderIdSchema = z.enum(['google', 'microsoft', 'dropbox'])

export const SourceOAuthStartRequestSchema = z.object({
  provider: SourceOAuthProviderIdSchema,
  connector: z.string(),
  origin: z.string().optional(),
  ownerUserId: z.string().optional(),
})

export const SourceOAuthStartResponseSchema = z.object({
  authorizeUrl: z.string(),
  state: z.string(),
  expiresAt: z.string(),
})

export const SourceOAuthGrantSchema = z.object({
  id: z.string(),
  provider: z.string(),
  account: z.string().nullable(),
  scopes: z.array(z.string()),
  status: z.enum(['active', 'revoked', 'broken']),
  actor: z.string(),
  ownerUserId: z.string().nullable(),
  accessExpiresAt: z.string().nullable(),
  refreshable: z.boolean(),
  lastRefreshAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
})

export const SourceOAuthProviderStateSchema = z.object({
  id: SourceOAuthProviderIdSchema,
  title: z.string(),
  configured: z.boolean(),
  redirectUri: z.string(),
})

export const SourceOAuthGrantsResponseSchema = z.object({
  grants: z.array(SourceOAuthGrantSchema),
  providers: z.array(SourceOAuthProviderStateSchema),
  ready: z.boolean(),
})

export const RevokeGrantResponseSchema = z.object({
  revoked: z.boolean(),
  providerRevoked: z.boolean(),
})

/** The message the brain's callback page posts to the window that opened it. */
export const OAuthPopupMessageSchema = z.discriminatedUnion('ok', [
  z.object({
    type: z.literal('brain-source-oauth'),
    ok: z.literal(true),
    grantId: z.string(),
    provider: z.string(),
    account: z.string().nullable(),
  }),
  z.object({ type: z.literal('brain-source-oauth'), ok: z.literal(false), error: z.string() }),
])

export const BrowseResponseSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  roots: z.array(z.string()),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
  files: z.number().int(),
  truncated: z.boolean(),
})

export type SourceConnection = z.infer<typeof SourceConnectionSchema>
export type SourceConnectionsListResponse = z.infer<
  typeof SourceConnectionsListResponseSchema
>
export type SourceItem = z.infer<typeof SourceItemSchema>
export type SourceItemsListResponse = z.infer<
  typeof SourceItemsListResponseSchema
>
export type SourceSyncSummary = z.infer<typeof SourceSyncSummarySchema>
export type SyncNowResponse = z.infer<typeof SyncNowResponseSchema>
export type SourceCatalogEntry = z.infer<typeof SourceCatalogEntrySchema>
export type SourceCatalogResponse = z.infer<typeof SourceCatalogResponseSchema>
export type SourceSchedule = z.infer<typeof ScheduleSchema>
export type SourceContentPolicy = z.infer<typeof ContentPolicySchema>
export type SourceDeletePolicy = z.infer<typeof DeletePolicySchema>
export type SourceItemState = z.infer<typeof ItemStateSchema>
export type SourceAvailability = z.infer<typeof AvailabilitySchema>
export type SourceConnectionStats = z.infer<typeof SourceConnectionStatsSchema>
export type SourceRun = z.infer<typeof SourceRunSchema>
export type SourceRunsResponse = z.infer<typeof SourceRunsResponseSchema>
export type SourceItemFact = z.infer<typeof SourceItemFactSchema>
export type SourceItemDocument = z.infer<typeof SourceItemDocumentSchema>
export type SourceItemAsset = z.infer<typeof SourceItemAssetSchema>
export type SourceItemInspectResponse = z.infer<
  typeof SourceItemInspectResponseSchema
>
export type SourceAgent = z.infer<typeof SourceAgentSchema>
export type SourceAgentsResponse = z.infer<typeof SourceAgentsResponseSchema>
export type BrowseResponse = z.infer<typeof BrowseResponseSchema>
export type SourceOAuthProviderId = z.infer<typeof SourceOAuthProviderIdSchema>
export type SourceOAuthStartRequest = z.infer<typeof SourceOAuthStartRequestSchema>
export type SourceOAuthStartResponse = z.infer<typeof SourceOAuthStartResponseSchema>
export type SourceOAuthGrant = z.infer<typeof SourceOAuthGrantSchema>
export type SourceOAuthProviderState = z.infer<typeof SourceOAuthProviderStateSchema>
export type SourceOAuthGrantsResponse = z.infer<typeof SourceOAuthGrantsResponseSchema>
export type RevokeGrantResponse = z.infer<typeof RevokeGrantResponseSchema>
export type OAuthPopupMessage = z.infer<typeof OAuthPopupMessageSchema>
