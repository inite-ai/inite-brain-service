import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/baselines.
 *
 * Mirrors BaselineEntry from baseline.service.ts. The controller
 * returns the raw array (not wrapped in `{ rows: ... }`), so the
 * schema is the array itself.
 *
 * Duplicated in brain-landing/lib/contracts/admin-baselines.ts.
 */

const BaselineEntrySchema = z.object({
  name: z.string(),
  savedAt: z.string(),
  scenarios: z.number(),
  meanRecallAt1: z.number(),
});

export const BaselinesResponseSchema = z.array(BaselineEntrySchema);

export type BaselinesResponse = z.infer<typeof BaselinesResponseSchema>;
export type BaselineEntry = z.infer<typeof BaselineEntrySchema>;
