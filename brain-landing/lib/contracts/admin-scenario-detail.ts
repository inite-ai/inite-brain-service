import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/scenarios/:id.
 *
 * **Duplicate** of src/contracts/admin/scenario-detail.schema.ts.
 */

const OpenRecord = z.record(z.string(), z.unknown())

export const ScenarioDetailResponseSchema = z.object({
  id: z.string(),
  vertical: z.string(),
  description: z.string(),
  setup: z.array(OpenRecord),
  queries: z.array(OpenRecord),
  memoryAssertions: z.array(OpenRecord).optional(),
  identityMerge: OpenRecord.optional(),
  synthesizeQueries: z.array(OpenRecord).optional(),
})

export type ScenarioDetailResponse = z.infer<
  typeof ScenarioDetailResponseSchema
>
