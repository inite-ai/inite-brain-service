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

/**
 * Why a catalogue entry can or cannot be connected right now:
 *   ready    — the connector is installed and switched on;
 *   disabled — installed, switched off (SOURCE_KIND_<KIND>);
 *   missing  — the pack names a connector this build does not ship;
 *   agent    — runs on the local agent (stdio MCP), never on the server;
 *   external — the publisher pushes through the doors; a connection is
 *              only the registry identity the pushes are attributed to.
 */
export const SourceAvailabilitySchema = z.enum([
  'ready',
  'disabled',
  'missing',
  'agent',
  'external',
]);
export type SourceAvailability = z.infer<typeof SourceAvailabilitySchema>;

/** One connectable `sources[]` entry of an installed (or builtin) pack. */
export const SourceCatalogEntrySchema = z.object({
  packId: z.string(),
  packVersion: z.string(),
  builtin: z.boolean(),
  /** False = the install predates or never accepted this sources section;
   *  `create` refuses until the pack is reinstalled with acceptSources. */
  accepted: z.boolean(),
  sourceId: z.string(),
  kind: SourceKindSchema,
  connector: z.string(),
  shape: SourceShapeSchema,
  title: z.string().nullable(),
  description: z.string().nullable(),
  defaults: z.object({
    contentPolicy: SourceContentPolicySchema,
    deletePolicy: SourceDeletePolicySchema,
    schedule: SourceScheduleSchema,
  }),
  availability: SourceAvailabilitySchema,
  /** Pre-fill for the connection `config`; never secrets. */
  configExample: z.record(z.string(), z.unknown()).nullable(),
  credentialHint: z.string().nullable(),
});
export type SourceCatalogEntry = z.infer<typeof SourceCatalogEntrySchema>;

export const SourceConnectorStateSchema = z.object({
  kind: z.string(),
  state: z.enum(['ready', 'disabled']),
  /** The env switch that turns it on. */
  flag: z.string(),
});
export type SourceConnectorState = z.infer<typeof SourceConnectorStateSchema>;

/**
 * GET /v1/admin/source-connections/catalog — what this tenant can
 * connect on this deployment: every declared source of every pack it
 * has (with consent state), the shipped connectors and their switches,
 * and the two operator fences (fs root jail, private-egress opt-in).
 */
export const SourceCatalogResponseSchema = z.object({
  sources: z.array(SourceCatalogEntrySchema),
  connectors: z.array(SourceConnectorStateSchema),
  fsRoots: z.array(z.string()),
  egressAllowPrivate: z.boolean(),
});
export type SourceCatalogResponse = z.infer<typeof SourceCatalogResponseSchema>;

// ── Agent-host run protocol (W3) ───────────────────────────────────────
//
// The local agent is the connector's OTHER host: it walks and fetches on
// its own machine and the engine keeps the books here. One run = one
// job_run; the agent begins it, streams deltas (the server answers with
// what it must fetch), posts each fetched item's content, and finishes
// with the checkpoint. Everything an agent sends is data through the
// ordinary doors under the connection's recorder — never a tool, never
// a prompt.

/** `agent:<id>` — the host string an agent-run connection carries. */
export const AGENT_HOST = /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const ItemDescriptorWireSchema = z.object({
  externalId: z.string().min(1).max(2048),
  originUri: z.string().max(2048).optional(),
  path: z.string().max(2048).optional(),
  title: z.string().max(512).optional(),
  mediaType: z.string().max(128).optional(),
  size: z.number().int().nonnegative().optional(),
  revision: z.string().max(256).optional(),
  modifiedAt: z.string().max(64).optional(),
  acl: z.record(z.string(), z.unknown()).optional(),
});

export const ItemDeltaWireSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upsert'), item: ItemDescriptorWireSchema }),
  z.object({ type: z.literal('gone'), externalId: z.string().min(1).max(2048) }),
  z.object({ type: z.literal('checkpoint'), checkpoint: z.record(z.string(), z.unknown()) }),
]);
export type ItemDeltaWire = z.infer<typeof ItemDeltaWireSchema>;

export const FetchedItemWireSchema = z.discriminatedUnion('shape', [
  z.object({
    shape: z.literal('document'),
    text: z.string().min(1),
    title: z.string().max(512).optional(),
    occurredAt: z.string().max(64).optional(),
    kind: z.string().max(64).optional(),
  }),
  z.object({
    shape: z.literal('binary'),
    /** Base64 — JSON carries no bytes. */
    bytesBase64: z.string().min(1),
    mediaType: z.string().min(1).max(128),
    modality: z.enum(['image', 'audio', 'video', 'document', 'sensor']),
    occurredAt: z.string().max(64).optional(),
  }),
  z.object({
    shape: z.literal('conversation'),
    conversationId: z.string().min(1).max(512),
    turns: z
      .array(
        z.object({
          text: z.string().min(1),
          speaker: z.string().max(200).optional(),
          role: z.string().max(40).optional(),
          at: z.string().max(64).optional(),
          messageId: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(5000),
  }),
  z.object({
    shape: z.literal('structure'),
    record: z.object({
      entityType: z.string().min(1).max(64),
      externalId: z.string().min(1).max(512),
      name: z.string().min(1).max(512),
      attributes: z.record(
        z.string().max(64),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      ),
      relations: z
        .array(
          z.object({
            kind: z.string().max(64),
            targetType: z.string().max(64),
            targetExternalId: z.string().max(512),
            targetName: z.string().max(512).optional(),
          }),
        )
        .max(500)
        .optional(),
      updatedAt: z.string().max(64).optional(),
    }),
  }),
]);
export type FetchedItemWire = z.infer<typeof FetchedItemWireSchema>;

export const BeginAgentRunRequestSchema = z.object({
  agentId: z.string().regex(AGENT_ID),
  full: z.boolean().optional(),
});
export type BeginAgentRunRequest = z.infer<typeof BeginAgentRunRequestSchema>;

export const BeginAgentRunResponseSchema = z.object({
  runId: z.string(),
  /** True ⇒ re-emit every live item; what the run does not see is gone. */
  full: z.boolean(),
  checkpoint: z.record(z.string(), z.unknown()).nullable(),
  contentPolicy: SourceContentPolicySchema,
  fetchBudget: z.number().int().nullable(),
});
export type BeginAgentRunResponse = z.infer<typeof BeginAgentRunResponseSchema>;

export const AGENT_DELTAS_MAX = 1000;

export const AgentDeltasRequestSchema = z.object({
  deltas: z.array(ItemDeltaWireSchema).min(1).max(AGENT_DELTAS_MAX),
});
export type AgentDeltasRequest = z.infer<typeof AgentDeltasRequestSchema>;

export const AgentDeltasResponseSchema = z.object({
  /** externalIds whose content the agent must now post (revision moved). */
  fetch: z.array(z.string()),
  seen: z.number().int(),
  new: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
  gone: z.number().int(),
});
export type AgentDeltasResponse = z.infer<typeof AgentDeltasResponseSchema>;

export const AgentItemResponseSchema = z.object({
  status: z.enum(['ingested', 'deduplicated', 'failed', 'skipped']),
  error: z.string().optional(),
});
export type AgentItemResponse = z.infer<typeof AgentItemResponseSchema>;

export const FinishAgentRunRequestSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  error: z.string().max(2000).optional(),
  checkpoint: z.record(z.string(), z.unknown()).optional(),
});
export type FinishAgentRunRequest = z.infer<typeof FinishAgentRunRequestSchema>;

/** An agent's view of one of its connections: the row plus the pack entry it runs. */
export const AgentConnectionSchema = z.object({
  connection: SourceConnectionSchema,
  /** The pack's `sources[]` entry (transport / command / connector …); null when the pack no longer declares it. */
  source: z.record(z.string(), z.unknown()).nullable(),
});
export const AgentConnectionsListResponseSchema = z.object({
  connections: z.array(AgentConnectionSchema),
});
export type AgentConnectionsListResponse = z.infer<typeof AgentConnectionsListResponseSchema>;

export function isConnectionId(v: string): boolean {
  return CONNECTION_ID.test(v);
}
