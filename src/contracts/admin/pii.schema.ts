import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/pii.
 *
 * Duplicated in brain-landing/lib/contracts/admin-pii.ts.
 */

const PiiRowSchema = z.object({
  companyId: z.string(),
  predicate: z.string(),
  piiClass: z.string(),
  requiresScope: z.string(),
  factCount: z.number(),
  retractedCount: z.number(),
});

export const PiiInventoryResponseSchema = z.object({
  rows: z.array(PiiRowSchema),
});

export type PiiInventoryResponse = z.infer<typeof PiiInventoryResponseSchema>;
export type PiiRow = z.infer<typeof PiiRowSchema>;
