import { z } from 'zod';
import { JobRowSchema } from './jobs.schema';

/**
 * Wire contract for GET /v1/admin/dreams/summary.
 *
 * Dreams cockpit: list of recent job_run rows (filtered to jobType
 * 'dreams') + 30-day aggregate counters.
 *
 * Duplicated in brain-landing/lib/contracts/admin-dreams-summary.ts.
 */

export const DreamsSummaryResponseSchema = z.object({
  runs: z.array(JobRowSchema),
  aggregates30d: z.object({
    totalRuns: z.number(),
    failed: z.number(),
    identityLinksCreated: z.number(),
    resolutionsApplied: z.number(),
  }),
});

export type DreamsSummaryResponse = z.infer<
  typeof DreamsSummaryResponseSchema
>;
