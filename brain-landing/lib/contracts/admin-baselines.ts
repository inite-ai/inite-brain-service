import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/baselines.
 *
 * **Duplicate** of src/contracts/admin/baselines.schema.ts.
 */

const BaselineEntrySchema = z.object({
  name: z.string(),
  savedAt: z.string(),
  scenarios: z.number(),
  meanRecallAt1: z.number(),
})

export const BaselinesResponseSchema = z.array(BaselineEntrySchema)

export type BaselinesResponse = z.infer<typeof BaselinesResponseSchema>
export type BaselineEntry = z.infer<typeof BaselineEntrySchema>
