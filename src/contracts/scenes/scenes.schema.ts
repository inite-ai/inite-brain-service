import { z } from 'zod';

/**
 * Wire contracts for the scene read API (GET /v1/scenes,
 * GET /v1/scenes/:id — SCENES_API_ENABLED, default on → `=0` is a 404).
 * Serves the memory_episode substrate (migration 0106) the composer
 * writes and the belief promotion reads: "what happened, together,
 * when". Runtime parity with the service result types is pinned by
 * test/contracts-scenes.unit-spec.ts.
 */

/** Per-dimension memory value (0106: a vector, never one scalar). */
export const SceneMemoryValueSchema = z.object({
  novelty: z.number().optional(),
  contradiction: z.number().optional(),
  stateChange: z.number().optional(),
  identity: z.number().optional(),
  explicitness: z.number().optional(),
  estimatedUtility: z.number().optional(),
  scorerVersion: z.string().optional(),
});

/** One enrichment-owned state delta ({subject, field, from, to}). */
export const SceneStateDeltaSchema = z.object({
  subject: z.string(),
  field: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const SceneReadResponseSchema = z.object({
  sceneId: z.string(),
  /** The one user the scene belongs to; absent on a mixed-user scene. */
  userId: z.string().optional(),
  /** Every user whose turns the scene covers (0117). */
  userIds: z.array(z.string()),
  sceneLabel: z.string(),
  /** Canonical gist — deterministic render, the one the lane serves. */
  gist: z.string(),
  /** LLM-enriched gist when the enricher has run on this scene. */
  enrichedGist: z.string().optional(),
  occurredFrom: z.string(),
  occurredTo: z.string(),
  recordedAt: z.string(),
  conversationIds: z.array(z.string()),
  /** Member turns (episode record ids) in scene order. */
  episodeIds: z.array(z.string()),
  /** Knowledge-graph backlinks written by the scene backlinker. */
  entityIds: z.array(z.string()),
  /** Facts the scene was consolidated into. */
  factIds: z.array(z.string()),
  unexpectedDetails: z.array(z.string()),
  stateDeltas: z.array(SceneStateDeltaSchema),
  memoryValue: SceneMemoryValueSchema.optional(),
  confidence: z.number(),
  /** The segmenter world the scene belongs to. */
  segmenterVersion: z.string(),
  /** True when the LLM enricher has stamped this scene. */
  enriched: z.boolean(),
});

export const ScenesListResponseSchema = z.object({
  /** Scenes visible to the caller after every fence, page-capped. */
  scenes: z.array(SceneReadResponseSchema),
  /** Rows returned (NOT a total count — the page size after fencing). */
  found: z.number(),
  /** The segmenter world served — '' when no world has been built. */
  world: z.string(),
});

export type SceneReadResponse = z.infer<typeof SceneReadResponseSchema>;
export type ScenesListResponse = z.infer<typeof ScenesListResponseSchema>;
