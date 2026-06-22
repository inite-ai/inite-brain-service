import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/scenarios/:id.
 *
 * Single Scenario (the full eval definition, not the ListItem
 * summary). The shape is heavy — setup steps, query expectations,
 * memory assertions — and the consumer (the eval UI's scenario
 * detail page) reads it back fairly faithfully. We pin only the
 * top-level envelope; nested step shapes are kept as open records
 * because the eval-type module owns them and they're inputs to a
 * different subsystem.
 *
 * Duplicated in brain-landing/lib/contracts/admin-scenario-detail.ts.
 */

const OpenRecord = z.record(z.string(), z.unknown());

export const ScenarioDetailResponseSchema = z.object({
  id: z.string(),
  vertical: z.string(),
  description: z.string(),
  setup: z.array(OpenRecord),
  queries: z.array(OpenRecord),
  memoryAssertions: z.array(OpenRecord).optional(),
  identityMerge: OpenRecord.optional(),
  synthesizeQueries: z.array(OpenRecord).optional(),
});

export type ScenarioDetailResponse = z.infer<
  typeof ScenarioDetailResponseSchema
>;
