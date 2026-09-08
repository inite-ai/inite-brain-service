import { z } from 'zod';

/**
 * Wire contracts for the entity READ surface — autocomplete, profile,
 * bitemporal timeline and typed connections
 * (src/entities/entities.controller.ts). Parity with the service result
 * types is pinned by test/contracts-entities.unit-spec.ts.
 *
 * The GDPR cascade (POST /v1/entities/:id/forget, scope `brain:admin`)
 * is NOT part of this file — it is an operator action, documented on the
 * admin surface in docs/api.md.
 */

export const EntityAutocompleteSuggestionSchema = z.object({
  entityId: z.string(),
  canonicalName: z.string(),
  type: z.string(),
  /** BM25 relevance from `search::score` over the edge-ngram prefix index. */
  score: z.number(),
});

export const EntityAutocompleteResponseSchema = z.object({
  suggestions: z.array(EntityAutocompleteSuggestionSchema),
});

export const EntityProfileFactSchema = z.object({
  factId: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number(),
  validFrom: z.string(),
  validUntil: z.string().optional(),
  status: z.string(),
});

export const EntityProfileResponseSchema = z.object({
  entityId: z.string(),
  type: z.string(),
  canonicalName: z.string(),
  externalRefs: z.record(z.string(), z.string()),
  /**
   * Set when the entity was merged into another (identity_of cascade):
   * treat it as a redirect and fetch `mergedInto`. Both absent on live
   * entities.
   */
  mergedAt: z.string().optional(),
  mergedInto: z.string().optional(),
  facts: z.array(EntityProfileFactSchema),
});

/** A fact entered the graph. */
export const TimelineRecordedEventSchema = z.object({
  type: z.literal('fact.recorded'),
  /** Transaction-time instant (ISO-8601). */
  at: z.string(),
  factId: z.string(),
  predicate: z.string(),
  object: z.string(),
  /** The stored FLEXIBLE `source` object, verbatim. */
  source: z.unknown(),
  confidence: z.number(),
});

/** A fact left the graph — retracted, or superseded by a newer claim. */
export const TimelineRetractedEventSchema = z.object({
  type: z.literal('fact.retracted'),
  at: z.string(),
  factId: z.string(),
  /** The stored retractedBy object, verbatim. */
  retractedBy: z.unknown(),
  reason: z.unknown(),
  supersededBy: z.string().optional(),
});

export const TimelineEventSchema = z.union([
  TimelineRecordedEventSchema,
  TimelineRetractedEventSchema,
]);

export const EntityTimelineResponseSchema = z.object({
  entityId: z.string(),
  /** Transaction-time sweep, oldest first within the requested window. */
  events: z.array(TimelineEventSchema),
});

export const ConnectionNeighbourSchema = z.object({
  id: z.string(),
  type: z.string(),
  canonicalName: z.string(),
});

export const ConnectionEdgeSchema = z.object({
  edgeId: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  weight: z.number(),
  /** The stored FLEXIBLE edge `source` object, verbatim. */
  source: z.unknown(),
  createdAt: z.string(),
  /** The entity on the far end; absent when the projection could not resolve it. */
  neighbour: ConnectionNeighbourSchema.optional(),
  direction: z.enum(['outbound', 'inbound']),
});

export const EntityConnectionsResponseSchema = z.object({
  entityId: z.string(),
  edges: z.array(ConnectionEdgeSchema),
});

export type EntityAutocompleteResponse = z.infer<typeof EntityAutocompleteResponseSchema>;
export type EntityProfileResponse = z.infer<typeof EntityProfileResponseSchema>;
export type EntityTimelineResponse = z.infer<typeof EntityTimelineResponseSchema>;
export type EntityConnectionsResponse = z.infer<typeof EntityConnectionsResponseSchema>;
