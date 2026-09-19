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
  /** The connected account it runs as (`credential = oauth:<grant>`), else null. */
  grantId: z.string().nullable(),
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
  /**
   * The inbound webhook (W4.2c): `enabled` = a secret is set and the
   * vendor may call `POST /v1/source-connections/webhook/<address>`;
   * the secret itself is shown once, at setup, never here.
   */
  webhook: z.object({ enabled: z.boolean(), lastEventAt: z.string().nullable() }),
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

// ── Inbound webhooks (W4.2c) ────────────────────────────────────────────
// A vendor that can call a URL on change (HubSpot, Pipedrive, Bitrix24,
// Kommo, a custom backend) is pointed at the connection's webhook
// address; the event names the entity + id and the engine fetches THAT
// record through the same door a sync uses — the webhook never carries
// data into memory. The address encodes the tenant and the connection
// under an HMAC; the secret authenticates the vendor (or the vendor's
// own signature does).

export const WEBHOOK_SECRET_MIN = 16;
export const WEBHOOK_SECRET_MAX = 256;

/** POST /v1/admin/source-connections/:id/webhook — switch the webhook on (a secret is generated unless given). */
export const WebhookSetupRequestSchema = z.object({
  /** The vendor's own token when the vendor issues it (Bitrix24 application token, a HubSpot app's client secret); absent = generated. */
  secret: z.string().min(WEBHOOK_SECRET_MIN).max(WEBHOOK_SECRET_MAX).optional(),
});
export type WebhookSetupRequest = z.infer<typeof WebhookSetupRequestSchema>;

export const WebhookSetupResponseSchema = z.object({
  /** What to register at the vendor. Kommo / signed: the secret rides in it as `?token=`. */
  url: z.string(),
  /** Shown ONCE — the brain keeps it encrypted. */
  secret: z.string(),
  scheme: z.string(),
  /** How to register it at this vendor, one line each. */
  notes: z.array(z.string()),
});
export type WebhookSetupResponse = z.infer<typeof WebhookSetupResponseSchema>;

/** What one webhook call did (inline) or will do (queued). */
export const WebhookApplySummarySchema = z.object({
  connectionId: z.string(),
  received: z.number().int(),
  fetched: z.number().int(),
  ingested: z.number().int(),
  deduplicated: z.number().int(),
  gone: z.number().int(),
  closed: z.number().int(),
  failed: z.number().int(),
  errors: z.array(z.object({ externalId: z.string(), error: z.string() })),
});
export type WebhookApplySummary = z.infer<typeof WebhookApplySummarySchema>;

/** POST /v1/source-connections/webhook/:address — the vendor's receipt. */
export const WebhookReceiptSchema = z.object({
  /** Events that named an entity this connection syncs. */
  accepted: z.number().int(),
  /** Events for other entities / unparseable ones — acknowledged, not fetched. */
  ignored: z.number().int(),
  /** Queued: the job that will fetch them; inline (no queue): null and `summary` set. */
  runId: z.string().nullable(),
  summary: WebhookApplySummarySchema.optional(),
});
export type WebhookReceipt = z.infer<typeof WebhookReceiptSchema>;

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
  /**
   * Where a connection of this entry may run: the brain (`server`) and/or
   * a local agent (`agent`). fs runs on both; url / s3 / http MCP on the
   * brain; git / stdio MCP on an agent only; an external entry is an
   * identity, not a runner.
   */
  hosts: z.array(z.enum(['server', 'agent'])),
  /** The MCP entry's declared transport, so the form knows what to ask for. */
  mcp: z
    .object({
      transport: z.enum(['http', 'stdio']),
      /** Pinned by the pack (read-only) or null = the operator names it. */
      url: z.string().nullable(),
      auth: z.enum(['none', 'install_secret', 'oauth']).nullable(),
      command: z.string().nullable(),
      args: z.array(z.string()),
    })
    .nullable(),
  /**
   * Set when the connector authenticates through a connected account
   * (W4): which provider, the scopes a grant needs, and whether this
   * deployment has an app registered for it (SOURCE_OAUTH_<P>_CLIENT_ID).
   */
  oauth: z
    .object({
      provider: z.string(),
      title: z.string(),
      scopes: z.array(z.string()),
      configured: z.boolean(),
    })
    .nullable(),
  /**
   * A records connector (W4.2): the entity types it can list, their
   * fields, and the preset mapping of fields to the pack vocabulary —
   * what the connect form's "what to sync" and mapping table show.
   */
  records: z
    .object({
      entities: z.array(
        z.object({
          type: z.string(),
          label: z.string(),
          defaultOn: z.boolean(),
          fields: z.array(z.object({ key: z.string(), label: z.string() })),
        }),
      ),
      preset: z.record(z.string(), z.unknown()),
      /** The pack's predicate localIds a field may map to. */
      predicates: z.array(z.object({ localId: z.string(), label: z.string() })),
    })
    .nullable(),
  /**
   * The connector takes an inbound webhook (W4.2c): how the vendor
   * signs its calls — its own signature (`hubspot`), HTTP Basic
   * (`pipedrive`), an application token in the body (`bitrix24`), or
   * the brain's own secret in the URL / a header (`kommo`, `signed`).
   */
  webhook: z.object({ scheme: z.string() }).nullable(),
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
  /** SOURCE_WEBHOOKS is on: connections of a vendor with a lane can be given an address (W4.2c). */
  webhooks: z.boolean(),
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

// ── Records (W4.2: docs/roadmap/crm-sources-2026-09.md) ─────────────────

/** The record envelope — entities + attributes + relations + a revision; the shape every CRM transport funnels into. */
export const RecordEnvelopeWireSchema = z.object({
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
});
export type RecordEnvelopeWire = z.infer<typeof RecordEnvelopeWireSchema>;

/** How one entity type's attributes become facts (records/record-mapping.ts) — bounded on purpose. */
export const EntityMappingSchema = z.object({
  fields: z.record(z.string().max(64), z.string().max(96)),
  text: z.array(z.string().max(64)).max(16).optional(),
  lifecycle: z
    .object({
      field: z.string().max(64),
      model: z.string().max(64),
      states: z.record(z.string().max(128), z.string().max(64)).optional(),
    })
    .optional(),
  coreType: z
    .enum(['customer', 'staff', 'asset', 'project', 'topic', 'location', 'other'])
    .optional(),
});
export const RecordMappingSchema = z.record(z.string().max(64), EntityMappingSchema);
export type RecordMappingWire = z.infer<typeof RecordMappingSchema>;

/** POST /v1/source-connections/:id/records — a batch pushed by a webhook or an automation. */
export const PushRecordsRequestSchema = z.object({
  records: z.array(RecordEnvelopeWireSchema).max(200),
  /** `<entityType>/<externalId>` of records that no longer exist at the source. */
  gone: z.array(z.string().min(1).max(600)).max(200).optional(),
  /** The revision of the source these were read at (else each record's updatedAt). */
  sourceVersion: z.string().max(200).optional(),
});
export type PushRecordsRequest = z.infer<typeof PushRecordsRequestSchema>;

export const PushRecordsResponseSchema = z.object({
  runId: z.string().nullable(),
  received: z.number().int(),
  ingested: z.number().int(),
  deduplicated: z.number().int(),
  failed: z.number().int(),
  gone: z.number().int(),
  closed: z.number().int(),
  errors: z.array(z.object({ externalId: z.string(), error: z.string() })),
});
export type PushRecordsResponse = z.infer<typeof PushRecordsResponseSchema>;

/** POST /v1/admin/source-connections/preview — one page per entity, mapped, before a connection exists. */
export const RecordsPreviewRequestSchema = z.object({
  packId: z.string().min(1).max(64),
  sourceId: z.string().min(1).max(40),
  config: z.record(z.string().max(64), z.unknown()).optional(),
  credential: z.string().max(4096).optional(),
  /** Records per entity (default 5, max 20). */
  limit: z.number().int().min(1).max(20).optional(),
});
export type RecordsPreviewRequest = z.infer<typeof RecordsPreviewRequestSchema>;

// ── The custom REST records source (W4.2b′, crm-sources § 4.3) ──
//
// `rest_records` is the one RecordsConnector whose entities are CONFIG,
// not code: per entity type a list endpoint, where the rows sit in the
// answer, one of five paging styles, one incremental filter, the id /
// name / updated-at fields and the relation fields — dotted paths only,
// no expressions. The mapping assistant proposes it from an OpenAPI
// document or a sample response; the preview verifies it by execution.

const DOTTED = z.string().min(1).max(128);
const ENTITY_TYPE = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export const RestPagingSchema = z.object({
  style: z.enum(['none', 'page', 'offset', 'cursor', 'link']),
  /** The page number / offset / cursor parameter (query for GET, body for POST). */
  param: z.string().max(64).optional(),
  sizeParam: z.string().max(64).optional(),
  size: z.number().int().min(1).max(1000).optional(),
  /** The first page number (page style, default 1) or offset (default 0). */
  start: z.number().int().min(0).optional(),
  /** Dotted path in the answer to the next cursor (cursor) or the next URL (link). */
  next: DOTTED.optional(),
});
export type RestPaging = z.infer<typeof RestPagingSchema>;

export const RestEntitySchema = z.object({
  label: z.string().max(64).optional(),
  list: z.object({
    /** Relative to `baseUrl` (a query string is kept); or absolute on the same origin. */
    path: z.string().min(1).max(512),
    method: z.enum(['GET', 'POST']).optional(),
    /** Fixed query parameters on every call. */
    query: z.record(z.string().max(64), z.string().max(256)).optional(),
    /** A fixed JSON body (POST). */
    body: z.record(z.string().max(64), z.unknown()).optional(),
  }),
  /** Dotted path to the rows in the answer (`data`, `result.items`, `_embedded.leads`); absent = the answer is the array, or its first array-valued property. */
  items: DOTTED.optional(),
  /** One record by id — `{id}` in the path. */
  get: z.object({ path: z.string().min(1).max(512) }).optional(),
  paging: RestPagingSchema.optional(),
  incremental: z
    .object({
      param: z.string().max(64),
      format: z.enum(['iso', 'epoch', 'epoch_ms', 'date']).optional(),
      in: z.enum(['query', 'body']).optional(),
    })
    .optional(),
  fields: z.object({
    id: DOTTED,
    /** Joined with a space; the first that yields something names the record. */
    name: z.array(DOTTED).min(1).max(4),
    updatedAt: DOTTED.optional(),
  }),
  /** Attribute key → dotted path; absent = every top-level scalar that is not an id / name / updated-at / relation field. */
  attributes: z.record(z.string().max(64), DOTTED).optional(),
  relations: z
    .array(
      z.object({
        kind: z.string().max(64),
        targetType: ENTITY_TYPE,
        /** Dotted path to the target id — a scalar, an object with `id`, or an array of either. */
        path: DOTTED,
        /** Dotted path to the target's name, when the row carries it. */
        name: DOTTED.optional(),
      }),
    )
    .max(16)
    .optional(),
  /** Dotted path; a truthy value means the row is deleted at the source (skipped). */
  deleted: DOTTED.optional(),
});
export type RestEntity = z.infer<typeof RestEntitySchema>;

export const RestRecordsConfigSchema = z.object({
  baseUrl: z.string().url().max(512),
  /** How the credential rides: `bearer` (default), `basic`, `header:<Name>`, `query:<name>`, `none`. */
  authScheme: z.string().max(80).optional(),
  /** Fixed headers on every call (never a secret — that is the credential). */
  headers: z.record(z.string().max(64), z.string().max(512)).optional(),
  allowPrivate: z.boolean().optional(),
  /** Entity type → its endpoints. */
  endpoints: z.record(ENTITY_TYPE, RestEntitySchema),
  /** Entity types to sync; absent = every configured one. */
  entities: z.array(ENTITY_TYPE).max(32).optional(),
  mapping: RecordMappingSchema.optional(),
  overlapMinutes: z.number().int().min(0).max(1440).optional(),
  maxRecords: z.number().int().min(1).max(500_000).optional(),
});
export type RestRecordsConfig = z.infer<typeof RestRecordsConfigSchema>;

/** POST /v1/admin/source-connections/assist — propose a `rest_records` config from an API description. */
export const MappingAssistRequestSchema = z.object({
  packId: z.string().min(1).max(64),
  baseUrl: z.string().url().max(512).optional(),
  /** An OpenAPI 3.x document — fetched (egress-guarded) or pasted (JSON or YAML, ≤ 2 MB). */
  openapi: z
    .object({
      url: z.string().url().max(2048).optional(),
      text: z.string().max(2_000_000).optional(),
    })
    .optional(),
  /** Sample answers of list endpoints, one per entity; `type` names the entity when the path does not. */
  samples: z
    .array(
      z.object({
        type: ENTITY_TYPE.optional(),
        path: z.string().max(512).optional(),
        json: z.unknown(),
      }),
    )
    .max(16)
    .optional(),
  /** The operator's own edits so far, kept over the proposal. */
  endpoints: z.record(ENTITY_TYPE, RestEntitySchema).optional(),
  allowPrivate: z.boolean().optional(),
});
export type MappingAssistRequest = z.infer<typeof MappingAssistRequestSchema>;

export const MappingAssistResponseSchema = z.object({
  /** The proposed `rest_records` config pieces: the endpoints and the field → predicate mapping. */
  endpoints: z.record(ENTITY_TYPE, RestEntitySchema),
  mapping: RecordMappingSchema,
  /** One row per proposed entity, with why. */
  entities: z.array(
    z.object({
      type: z.string(),
      label: z.string(),
      /** `openapi` — from the document; `sample` — from a pasted answer; `model` — the assistant's own call. */
      source: z.enum(['openapi', 'sample', 'model', 'operator']),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
      fields: z.array(z.object({ key: z.string(), label: z.string() })),
    }),
  ),
  /** Whether the model refined the proposal (SOURCE_MAPPING_ASSISTANT + a key). */
  refined: z.boolean(),
  warnings: z.array(z.string()),
});
export type MappingAssistResponse = z.infer<typeof MappingAssistResponseSchema>;

export const RecordsPreviewResponseSchema = z.object({
  entities: z.array(
    z.object({
      type: z.string(),
      label: z.string(),
      records: z.array(
        z.object({
          record: RecordEnvelopeWireSchema,
          facts: z.array(z.object({ predicate: z.string(), object: z.string() })),
          relations: z.array(z.object({ kind: z.string(), target: z.string() })),
          unmapped: z.array(z.string()),
          dropped: z.array(z.object({ key: z.string(), reason: z.string() })),
        }),
      ),
      error: z.string().nullable(),
    }),
  ),
});
export type RecordsPreviewResponse = z.infer<typeof RecordsPreviewResponseSchema>;

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
    record: RecordEnvelopeWireSchema,
    mapping: EntityMappingSchema.optional(),
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

// ── Inspection (the operator's drill-down) ─────────────────────────────

/** What a connection has produced: catalogue rows by state, facts it grounds. */
export const SourceConnectionStatsSchema = z.object({
  connectionId: z.string(),
  items: z.object({
    seen: z.number().int(),
    fetched: z.number().int(),
    indexed: z.number().int(),
    gone: z.number().int(),
    total: z.number().int(),
  }),
  /**
   * Facts whose `source.meta.source_connection` is this connection —
   * null when the tenant's fact table was too large to count in time
   * (the count is a scan; the answer is "many", not an error).
   */
  facts: z
    .object({
      active: z.number().int(),
      stale: z.number().int(),
      closed: z.number().int(),
    })
    .nullable(),
});
export type SourceConnectionStats = z.infer<typeof SourceConnectionStatsSchema>;

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
});
export type SourceRunCounters = z.infer<typeof SourceRunCountersSchema>;

/** One sync run of a connection — a `source_sync` job_run, whoever ran it. */
export const SourceRunSchema = z.object({
  runId: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'pending']),
  /** 'server' (queue or inline), 'agent:<id>', or 'webhook:<scheme>' (a vendor's call fetched by name). */
  ranBy: z.string(),
  triggeredBy: z.enum(['cron', 'manual', 'startup']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  /** `webhook` = a fetch-one batch, not a walk. */
  mode: z.enum(['full', 'incremental', 'webhook']).nullable(),
  /** Final counters (from the result) or the live ones (from progress) — null before the first delta. */
  counters: SourceRunCountersSchema.nullable(),
  skipped: z.string().nullable(),
  error: z.string().nullable(),
});
export type SourceRun = z.infer<typeof SourceRunSchema>;

export const SourceRunsResponseSchema = z.object({
  connectionId: z.string(),
  /** False ⇒ JOB_RUN_PERSIST is off and no history is kept. */
  persisted: z.boolean(),
  runs: z.array(SourceRunSchema),
});
export type SourceRunsResponse = z.infer<typeof SourceRunsResponseSchema>;

/** A fact this item grounds, with what the drift sweep sees. */
export const SourceItemFactSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number(),
  /** The revision the fact was read at (its SourceVersionStamp), if stamped. */
  version: z.string().nullable(),
  staleAt: z.string().nullable(),
  staleReason: z.string().nullable(),
  validUntil: z.string().nullable(),
  status: z.string(),
});
export type SourceItemFact = z.infer<typeof SourceItemFactSchema>;

export const SourceItemDocumentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  status: z.string().nullable(),
  originUri: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type SourceItemDocument = z.infer<typeof SourceItemDocumentSchema>;

export const SourceItemAssetSchema = z.object({
  id: z.string(),
  mediaType: z.string(),
  modality: z.string(),
  byteLength: z.number().int(),
  availability: z.string(),
  quarantineStatus: z.string().nullable(),
  /** Current (not superseded) derived representations: what the processors extracted. */
  representations: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      producerVersion: z.string(),
      chars: z.number().int(),
      createdAt: z.string().nullable(),
    }),
  ),
});
export type SourceItemAsset = z.infer<typeof SourceItemAssetSchema>;

/** One catalogue row opened: what the item became on the way to facts. */
export const SourceItemInspectResponseSchema = z.object({
  item: SourceItemSchema,
  /** The document(s) the item became — one for text, the bridge's parts for binary. */
  documents: z.array(SourceItemDocumentSchema),
  asset: SourceItemAssetSchema.nullable(),
  facts: z.array(SourceItemFactSchema),
  /** True ⇒ more facts than the page shows. */
  factsTruncated: z.boolean(),
});
export type SourceItemInspectResponse = z.infer<typeof SourceItemInspectResponseSchema>;

// ── Agents: presence + the folders they can see ────────────────────────

/**
 * The `db` source's config (W4.4) — a database read by the LOCAL AGENT
 * as records: the database by the NAME the agent holds a DSN for
 * (`brain-agent db add <name> <dsn>`; the DSN never reaches the brain),
 * one entity per table or view with its key, name and change columns,
 * the columns to read and the foreign keys read as relations. Every
 * identifier is a bare SQL identifier: the agent quotes it, nothing is
 * ever interpolated, no SQL travels.
 */
const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_TABLE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
export const DB_DATABASE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SqlIdentSchema = z.string().regex(SQL_IDENT, 'a SQL identifier');

export const DbSourceEntitySchema = z.object({
  type: SqlIdentSchema,
  table: z.string().regex(SQL_TABLE, 'a table or schema.table'),
  idColumn: SqlIdentSchema.optional(),
  nameColumn: SqlIdentSchema.optional(),
  updatedAtColumn: SqlIdentSchema.optional(),
  columns: z.array(SqlIdentSchema).max(200).optional(),
  relations: z
    .array(z.object({ kind: SqlIdentSchema, column: SqlIdentSchema, targetType: SqlIdentSchema }))
    .max(32)
    .optional(),
});
export type DbSourceEntity = z.infer<typeof DbSourceEntitySchema>;

/** Keys a `db` config must not carry: the DSN and its parts stay on the agent. */
export const DB_CONFIG_FORBIDDEN_KEYS = [
  'dsn',
  'url',
  'connectionString',
  'password',
  'user',
  'username',
  'host',
  'port',
] as const;

export const DbSourceConfigSchema = z
  .object({
    database: z.string().regex(DB_DATABASE_NAME, 'a database name (letters, digits, _ and -)'),
    entities: z.array(DbSourceEntitySchema).min(1).max(64),
    pageSize: z.number().int().positive().max(10_000).optional(),
    maxRows: z.number().int().positive().optional(),
    mapping: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type DbSourceConfig = z.infer<typeof DbSourceConfigSchema>;

export const AGENT_INVENTORY_MAX_FOLDERS = 2000;

/** What an agent reports on every pass: its identity and the folders under its roots. */
export const AgentInventorySchema = z.object({
  version: z.string().max(40).optional(),
  hostname: z.string().max(200).optional(),
  platform: z.string().max(40).optional(),
  roots: z
    .array(
      z.object({
        path: z.string().min(1).max(1000),
        /** Directories under the root as relative posix paths, depth-bounded, sorted. */
        folders: z.array(z.string().max(1000)).max(AGENT_INVENTORY_MAX_FOLDERS),
      }),
    )
    .max(32),
  /** The databases the agent holds a DSN for — names only (the `db` form's picker). */
  databases: z.array(z.string().regex(DB_DATABASE_NAME)).max(64).optional(),
});
export type AgentInventory = z.infer<typeof AgentInventorySchema>;

export const SourceAgentSchema = z.object({
  agentId: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  version: z.string().nullable(),
  hostname: z.string().nullable(),
  platform: z.string().nullable(),
  roots: z.array(z.object({ path: z.string(), folders: z.array(z.string()) })),
  databases: z.array(z.string()),
});
export type SourceAgent = z.infer<typeof SourceAgentSchema>;

export const SourceAgentsResponseSchema = z.object({ agents: z.array(SourceAgentSchema) });
export type SourceAgentsResponse = z.infer<typeof SourceAgentsResponseSchema>;

/** One level of the brain host's own disk, inside the SOURCE_FS_ROOTS jail. */
export const BrowseResponseSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  /** The jail roots — the picker's top level. */
  roots: z.array(z.string()),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
  /** Regular files in this directory (count only — the picker picks folders). */
  files: z.number().int(),
  truncated: z.boolean(),
});
export type BrowseResponse = z.infer<typeof BrowseResponseSchema>;

// ── Connected accounts (W4: the brain as an outbound OAuth client) ─────
//
// An admin connects an account once (`POST …/oauth/start` → the
// provider's consent page → the brain's callback) and gets a GRANT: the
// provider, an account label, the scopes, and a token set the brain
// keeps encrypted. A connection then names its grant as
// `credential: 'oauth:<grant id>'` and the engine resolves a fresh
// access token at run time. Tokens never appear on the wire.

const GRANT_ID = /^source_oauth_grant:[A-Za-z0-9_]+$/;

export const SourceOAuthProviderIdSchema = z.enum([
  'google',
  'microsoft',
  'dropbox',
  'pipedrive',
  'hubspot',
  'salesforce',
  'bitrix24',
  'kommo',
  'notion',
  'atlassian',
]);
export type SourceOAuthProviderId = z.infer<typeof SourceOAuthProviderIdSchema>;

export const SourceOAuthStartRequestSchema = z.object({
  provider: SourceOAuthProviderIdSchema,
  /** The connector the grant is for — its declared scopes are what is asked. */
  connector: z.string().min(1).max(32),
  /** The admin UI's origin: the callback page posts the result to it and nowhere else. */
  origin: z.string().url().max(256).optional(),
  /** Make the grant a user's (a personal connection's account). */
  ownerUserId: z.string().max(200).optional(),
});
export type SourceOAuthStartRequest = z.infer<typeof SourceOAuthStartRequestSchema>;

export const SourceOAuthStartResponseSchema = z.object({
  authorizeUrl: z.string(),
  state: z.string(),
  expiresAt: z.string(),
});
export type SourceOAuthStartResponse = z.infer<typeof SourceOAuthStartResponseSchema>;

export const SourceOAuthGrantStatusSchema = z.enum(['active', 'revoked', 'broken']);

export const SourceOAuthGrantSchema = z.object({
  id: z.string(),
  provider: z.string(),
  /** E-mail / login / workspace — what the admin sees; never a secret. */
  account: z.string().nullable(),
  scopes: z.array(z.string()),
  status: SourceOAuthGrantStatusSchema,
  actor: z.string(),
  ownerUserId: z.string().nullable(),
  /** When the current access token expires (the grant refreshes itself before). */
  accessExpiresAt: z.string().nullable(),
  /** Whether a refresh token was granted — without one the grant dies with its access token. */
  refreshable: z.boolean(),
  lastRefreshAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** The MCP server URL a `mcp` grant is for (W4.3); null for a static provider's grant. */
  resource: z.string().nullable(),
  /** The account's own API origin when the provider names one at the token endpoint (Salesforce `instance_url`, Pipedrive `api_domain`); a connector runs against it. */
  apiBase: z.string().nullable(),
  createdAt: z.string(),
});
export type SourceOAuthGrant = z.infer<typeof SourceOAuthGrantSchema>;

/**
 * POST /v1/admin/source-connections/oauth/mcp/start — sign in at an MCP
 * server (W4.3): its authorization server is discovered (RFC 9728 →
 * RFC 8414) and a client registered there (RFC 7591) unless the
 * operator passes one the server issued.
 */
export const SourceOAuthMcpStartRequestSchema = z.object({
  /** The MCP server URL (the pack's pinned url, or the operator-named one). */
  serverUrl: z.string().url().max(2048),
  /** The connection's half of the private-host double opt-in — the discovery runs under it. */
  allowPrivate: z.boolean().optional(),
  /** A client the operator registered at the server's authorization server, when it offers no dynamic registration. */
  client: z
    .object({
      clientId: z.string().min(1).max(512),
      clientSecret: z.string().max(2048).optional(),
    })
    .optional(),
  origin: z.string().url().max(256).optional(),
  ownerUserId: z.string().max(200).optional(),
});
export type SourceOAuthMcpStartRequest = z.infer<typeof SourceOAuthMcpStartRequestSchema>;

export const SourceOAuthMcpStartResponseSchema = SourceOAuthStartResponseSchema.extend({
  /** The canonical resource the grant will be for. */
  resource: z.string(),
});
export type SourceOAuthMcpStartResponse = z.infer<typeof SourceOAuthMcpStartResponseSchema>;

export const SourceOAuthProviderStateSchema = z.object({
  id: SourceOAuthProviderIdSchema,
  title: z.string(),
  /** SOURCE_OAUTH_<P>_CLIENT_ID is set on this deployment. */
  configured: z.boolean(),
  /** The redirect URI to register at the provider. */
  redirectUri: z.string(),
});
export type SourceOAuthProviderState = z.infer<typeof SourceOAuthProviderStateSchema>;

export const SourceOAuthGrantsResponseSchema = z.object({
  grants: z.array(SourceOAuthGrantSchema),
  providers: z.array(SourceOAuthProviderStateSchema),
  /** SOURCE_OAUTH_CLIENT is on and SOURCE_CREDENTIAL_ENCRYPTION_KEY is set. */
  ready: z.boolean(),
});
export type SourceOAuthGrantsResponse = z.infer<typeof SourceOAuthGrantsResponseSchema>;

export const RevokeGrantResponseSchema = z.object({
  revoked: z.boolean(),
  /** The provider accepted the revocation (best effort; false = revoke at the provider too). */
  providerRevoked: z.boolean(),
});
export type RevokeGrantResponse = z.infer<typeof RevokeGrantResponseSchema>;

export function isGrantId(v: string): boolean {
  return GRANT_ID.test(v);
}

/** The credential form that names a grant. */
export const OAUTH_CREDENTIAL_PREFIX = 'oauth:';

export function grantIdOfCredential(credential: string | null | undefined): string | null {
  if (typeof credential !== 'string' || !credential.startsWith(OAUTH_CREDENTIAL_PREFIX))
    return null;
  const id = credential.slice(OAUTH_CREDENTIAL_PREFIX.length);
  return GRANT_ID.test(id) ? id : null;
}

export function isConnectionId(v: string): boolean {
  return CONNECTION_ID.test(v);
}
