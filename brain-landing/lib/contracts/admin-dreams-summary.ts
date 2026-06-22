import { z } from 'zod'
import { JobRowSchema } from './admin-jobs'

/**
 * Wire contract for GET /v1/admin/dreams/summary.
 *
 * **Duplicate** of src/contracts/admin/dreams-summary.schema.ts.
 */

export const DreamsSummaryResponseSchema = z.object({
  runs: z.array(JobRowSchema),
  aggregates30d: z.object({
    totalRuns: z.number(),
    failed: z.number(),
    identityLinksCreated: z.number(),
    resolutionsApplied: z.number(),
  }),
})

export type DreamsSummaryResponse = z.infer<typeof DreamsSummaryResponseSchema>
