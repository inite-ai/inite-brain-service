import { z } from 'zod';

/**
 * Wire contracts for the raw-substrate driver v1
 * (docs/roadmap/raw-substrate-driver-2026-08.md): the public episodes
 * read API (surface 1), the projection registry (surface 3) and the
 * new-episode webhook subscriptions (surface 4). All routes 404 unless
 * their flag is on (EPISODES_API_ENABLED / PROJECTIONS_API_ENABLED /
 * EPISODE_SUBSCRIPTIONS_ENABLED).
 */

/** One verbatim L0 turn as served by GET /v1/episodes (toWire shape). */
export const EpisodeWireSchema = z.object({
  id: z.string(),
  kind: z.string(),
  conversationId: z.string().optional(),
  messageId: z.string(),
  speaker: z.string().optional(),
  addressee: z.string().optional(),
  text: z.string(),
  piiClass: z.array(z.string()).optional(),
  occurredAt: z.string(),
  recordedAt: z.string(),
  lang: z.string().optional(),
  source: z.record(z.string(), z.unknown()),
});
export type EpisodeWire = z.infer<typeof EpisodeWireSchema>;

export const EpisodesListResponseSchema = z.object({
  episodes: z.array(EpisodeWireSchema),
  /** Present exactly when the page is full; resume with ?cursor=. */
  nextCursor: z.string().optional(),
});
export type EpisodesListResponse = z.infer<typeof EpisodesListResponseSchema>;

export const PROJECTION_STATUSES = ['building', 'built', 'live', 'residual', 'failed'] as const;

/** One derived-surface version (projection registry row). */
export const ProjectionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.enum(PROJECTION_STATUSES),
  builder: z.string(),
  watermark: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
});
export type ProjectionRow = z.infer<typeof ProjectionRowSchema>;

export const ProjectionsListResponseSchema = z.object({
  projections: z.array(ProjectionRowSchema),
  /** The process-local live read pin (RETRIEVAL_DERIVED_VERSION). */
  readPin: z.string().nullable(),
});
export type ProjectionsListResponse = z.infer<typeof ProjectionsListResponseSchema>;

export const RebuildProjectionRequestSchema = z.object({
  /** Short kebab-case world tag; defaults to the builder's current version. */
  version: z.string().optional(),
  /** Restrict the rebuild to one conversation. */
  conversation: z.string().optional(),
  /** Flip the live read pin to this version after a successful run. */
  activate: z.boolean().optional(),
  /** Allow rewriting the currently pinned world in place (eval only). */
  force: z.boolean().optional(),
});
export type RebuildProjectionRequest = z.infer<typeof RebuildProjectionRequestSchema>;

export const RebuildProjectionResponseSchema = z.object({
  conversations: z.number().int(),
  sessions: z.number().int(),
  propositions: z.number().int(),
  unresolvedSubjects: z.number().int(),
  skipped: z.array(z.object({ conversationId: z.string(), reason: z.string() })),
  /**
   * 'ok' — clean run; 'degraded' — some conversations failed (reasons in
   * skipped). A run where every attempted conversation failed never
   * reaches the caller as a 2xx — the endpoint answers 502 instead.
   */
  status: z.enum(['ok', 'degraded', 'failed']),
  failed: z.number().int(),
  activated: z.boolean().optional(),
  previousVersion: z.string().nullable().optional(),
});
export type RebuildProjectionResponse = z.infer<typeof RebuildProjectionResponseSchema>;

export const CreateEpisodeSubscriptionRequestSchema = z.object({
  /** Absolute http(s) endpoint that will receive signed pushes. */
  url: z.string(),
});
export type CreateEpisodeSubscriptionRequest = z.infer<
  typeof CreateEpisodeSubscriptionRequestSchema
>;

export const CreateEpisodeSubscriptionResponseSchema = z.object({
  id: z.string(),
  /** HMAC signing secret — returned exactly once, store it. */
  secret: z.string(),
  /** Only episodes recorded after this instant will be announced. */
  watermark: z.string(),
});
export type CreateEpisodeSubscriptionResponse = z.infer<
  typeof CreateEpisodeSubscriptionResponseSchema
>;

/** Registered endpoint as listed (never includes the secret). */
export const EpisodeSubscriptionRowSchema = z.object({
  id: z.string(),
  url: z.string(),
  active: z.boolean(),
  watermark: z.string(),
  failureCount: z.number().int(),
  createdAt: z.string(),
});
export type EpisodeSubscriptionRowWire = z.infer<typeof EpisodeSubscriptionRowSchema>;

export const EpisodeSubscriptionsListResponseSchema = z.object({
  subscriptions: z.array(EpisodeSubscriptionRowSchema),
});
export type EpisodeSubscriptionsListResponse = z.infer<
  typeof EpisodeSubscriptionsListResponseSchema
>;

export const DeleteEpisodeSubscriptionResponseSchema = z.object({
  deleted: z.boolean(),
});
export type DeleteEpisodeSubscriptionResponse = z.infer<
  typeof DeleteEpisodeSubscriptionResponseSchema
>;

/**
 * The HMAC-signed webhook push body (X-Brain-Signature: sha256=<hex>
 * over the raw JSON). Metadata only — bodies are pulled through
 * GET /v1/episodes under the subscriber's own scopes.
 */
export const EpisodesAvailableEventSchema = z.object({
  event: z.literal('episodes_available'),
  delivery: z.literal('at-least-once'),
  episodes: z.array(
    z.object({
      id: z.string(),
      conversationId: z.string().optional(),
      messageId: z.string(),
      speaker: z.string().optional(),
      occurredAt: z.string(),
      recordedAt: z.string(),
    }),
  ),
  /** The watermark this batch advances to (max recordedAt). */
  watermark: z.string(),
  ts: z.string(),
});
export type EpisodesAvailableEventWire = z.infer<typeof EpisodesAvailableEventSchema>;
