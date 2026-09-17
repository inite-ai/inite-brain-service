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
