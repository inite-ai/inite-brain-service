import { z } from 'zod';
import { SourceItemSchema } from './source-plane.schema';

/**
 * Wire contracts for the operator's drill-down of one connection
 * (/v1/admin/source-connections/:id/{stats,runs,items/:itemId}, scope
 * brain:admin): what it produced, every run, one catalogue row followed
 * to its document, asset, episode turn and facts. Split from
 * source-plane.schema.ts, which re-exports it — the imports stay.
 */

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

/** The episode turn a conversation-shaped item became (a mail message, a chat message). */
export const SourceItemEpisodeSchema = z.object({
  id: z.string(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  speaker: z.string().nullable(),
  /** The turn as stored (PII-redacted, capped for the drawer). */
  text: z.string(),
  occurredAt: z.string().nullable(),
});
export type SourceItemEpisode = z.infer<typeof SourceItemEpisodeSchema>;

/** One catalogue row opened: what the item became on the way to facts. */
export const SourceItemInspectResponseSchema = z.object({
  item: SourceItemSchema,
  /** The document(s) the item became — one for text, the bridge's parts for binary. */
  documents: z.array(SourceItemDocumentSchema),
  asset: SourceItemAssetSchema.nullable(),
  /** The episode turn a conversation-shaped item became; null for the other shapes. */
  episode: SourceItemEpisodeSchema.nullable(),
  facts: z.array(SourceItemFactSchema),
  /** True ⇒ more facts than the page shows. */
  factsTruncated: z.boolean(),
});
export type SourceItemInspectResponse = z.infer<typeof SourceItemInspectResponseSchema>;

// ── The ACL mirror (W5) ──────────────────────────────────────────────
//
// What a connection's `principals()` walk saw, and what an operator has
// said about it. An identity with `userId: null` is an account nobody
// has claimed: it grants no visibility at all, which is why the surface
// shows it rather than hiding it.

export const SourceExternalIdentitySchema = z.object({
  externalId: z.string(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  /** The brain user this account IS, when someone has said. */
  userId: z.string().nullable(),
  /** 'operator' (an admin said so) | 'email' (followed a link already made). */
  linkedBy: z.string().nullable(),
});
export type SourceExternalIdentity = z.infer<typeof SourceExternalIdentitySchema>;

export const SourceMembershipTupleSchema = z.object({
  subject: z.string(),
  object: z.string(),
  source: z.string(),
  recordedAt: z.string(),
  /** Set = the membership ENDED then; the row stays so March is answerable. */
  revokedAt: z.string().nullable(),
});
export type SourceMembershipTuple = z.infer<typeof SourceMembershipTupleSchema>;

export const SourcePrincipalsResponseSchema = z.object({
  /** The tenant's consistency token: every cached expansion keys on it. */
  epoch: z.number().int(),
  identities: z.array(SourceExternalIdentitySchema),
  tuples: z.array(SourceMembershipTupleSchema),
});
export type SourcePrincipalsResponse = z.infer<typeof SourcePrincipalsResponseSchema>;

export const SourcePrincipalLinkRequestSchema = z.object({
  externalId: z.string().min(1).max(200),
  /** null = unlink: the account is nobody's again. */
  userId: z.string().min(1).max(200).nullable(),
});
export type SourcePrincipalLinkRequest = z.infer<typeof SourcePrincipalLinkRequestSchema>;
