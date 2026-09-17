import { z } from 'zod';
import {
  PACK_SOURCE_CONTENT_POLICIES,
  PACK_SOURCE_DELETE_POLICIES,
  PACK_SOURCE_KINDS,
  PACK_SOURCE_SCHEDULES,
  PACK_SOURCE_SHAPES,
} from '../../ai/domain-packs/manifest';

/**
 * Wire contracts for the source plane's operator surface
 * (/v1/admin/source-connections, scope brain:admin) — see
 * docs/roadmap/raw-evidence-sources-2026-09.md § 5.2. A connection is
 * the operator's decision to READ one external system through a pack's
 * declared `sources` entry; the catalogue (`source_item`) is what the
 * connection has seen there.
 */

const CONNECTION_ID = /^source_connection:[A-Za-z0-9_]+$/;

export const SourceConnectionStatusSchema = z.enum(['active', 'paused', 'deleting']);
export const SourceConnectionModeSchema = z.enum(['synced', 'linked']);
export const SourceScheduleSchema = z.enum(PACK_SOURCE_SCHEDULES);
export const SourceContentPolicySchema = z.enum(PACK_SOURCE_CONTENT_POLICIES);
export const SourceDeletePolicySchema = z.enum(PACK_SOURCE_DELETE_POLICIES);
export const SourceShapeSchema = z.enum(PACK_SOURCE_SHAPES);
export const SourceKindSchema = z.enum(PACK_SOURCE_KINDS);

/** Connector configuration — an object of scalars/arrays, never secrets. */
const ConfigSchema = z.record(z.string().max(64), z.unknown());

export const SourceConnectionSchema = z.object({
  id: z.string(),
  packId: z.string(),
  sourceId: z.string(),
  kind: SourceKindSchema,
  /** The Connector.kind that runs it ('fs', 'mcp', 'external', …). */
  connector: z.string(),
  shape: SourceShapeSchema,
  /** 'server' | 'agent:<id>' */
  host: z.string(),
  label: z.string().nullable(),
  config: ConfigSchema,
  /** Whether a credential is stored; the value never leaves the server. */
  hasCredential: z.boolean(),
  mode: SourceConnectionModeSchema,
  schedule: SourceScheduleSchema,
  contentPolicy: SourceContentPolicySchema,
  deletePolicy: SourceDeletePolicySchema,
  fetchBudget: z.number().int().positive().nullable(),
  status: SourceConnectionStatusSchema,
  checkpoint: z.record(z.string(), z.unknown()).nullable(),
  vertical: z.string(),
  recorder: z.string(),
  /** Its source_registry identity (`vertical:recorder`). */
  sourceKey: z.string(),
  /** Set = a personal connection: every row it writes is user-fenced. */
  ownerUserId: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type SourceConnection = z.infer<typeof SourceConnectionSchema>;

export const CreateSourceConnectionRequestSchema = z.object({
  packId: z.string().min(1).max(64),
  /** The pack's `sources[].id` this connection instantiates. */
  sourceId: z.string().min(1).max(40),
  /** contextRef.vertical for every item the connection ingests. */
  vertical: z.string().min(1).max(64),
  label: z.string().max(120).optional(),
  host: z.string().max(80).optional(),
  config: ConfigSchema.optional(),
  /** Stored as-is (tenant DB); never returned. */
  credential: z.string().max(4096).optional(),
  mode: SourceConnectionModeSchema.optional(),
  schedule: SourceScheduleSchema.optional(),
  contentPolicy: SourceContentPolicySchema.optional(),
  deletePolicy: SourceDeletePolicySchema.optional(),
  fetchBudget: z.number().int().positive().max(100_000).optional(),
  /** Make it a personal connection owned by this user. */
  ownerUserId: z.string().max(200).optional(),
});
export type CreateSourceConnectionRequest = z.infer<typeof CreateSourceConnectionRequestSchema>;

export const UpdateSourceConnectionRequestSchema = z.object({
  label: z.string().max(120).nullable().optional(),
  config: ConfigSchema.optional(),
  credential: z.string().max(4096).nullable().optional(),
  schedule: SourceScheduleSchema.optional(),
  contentPolicy: SourceContentPolicySchema.optional(),
  deletePolicy: SourceDeletePolicySchema.optional(),
  fetchBudget: z.number().int().positive().max(100_000).nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
});
export type UpdateSourceConnectionRequest = z.infer<typeof UpdateSourceConnectionRequestSchema>;

export const SourceConnectionsListResponseSchema = z.object({
  connections: z.array(SourceConnectionSchema),
});
export type SourceConnectionsListResponse = z.infer<typeof SourceConnectionsListResponseSchema>;

export const SourceItemStateSchema = z.enum(['seen', 'fetched', 'indexed', 'gone']);

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
  state: SourceItemStateSchema,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  goneAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type SourceItem = z.infer<typeof SourceItemSchema>;

export const SourceItemsListResponseSchema = z.object({
  items: z.array(SourceItemSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type SourceItemsListResponse = z.infer<typeof SourceItemsListResponseSchema>;

/** One sync run's counters — also the `job_run.result` of a queued run. */
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
});
export type SourceSyncSummary = z.infer<typeof SourceSyncSummarySchema>;

export const SyncNowRequestSchema = z.object({
  /** Re-enumerate everything and mark what is missing gone. */
  full: z.boolean().optional(),
  /** Run inline and return the summary (default: enqueue a job). */
  inline: z.boolean().optional(),
});
export type SyncNowRequest = z.infer<typeof SyncNowRequestSchema>;

export const SyncNowResponseSchema = z.union([
  z.object({ enqueued: z.literal(true), runId: z.string(), created: z.boolean() }),
  z.object({ enqueued: z.literal(false), summary: SourceSyncSummarySchema }),
]);
export type SyncNowResponse = z.infer<typeof SyncNowResponseSchema>;

export function isConnectionId(v: string): boolean {
  return CONNECTION_ID.test(v);
}
