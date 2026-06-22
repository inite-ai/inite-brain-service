import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/cost.
 *
 * Mirrors CostBreakdown from admin.service.ts.
 * Duplicated in brain-landing/lib/contracts/admin-cost.ts.
 */

const CostBucketSchema = z.object({
  key: z.string(),
  calls: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  usd: z.number(),
});

const PricingEntrySchema = z.object({
  promptPerMTok: z.number(),
  completionPerMTok: z.number(),
});

export const CostResponseSchema = z.object({
  total: z.object({
    usd: z.number(),
    tokens: z.number(),
    calls: z.number(),
  }),
  perModel: z.array(CostBucketSchema),
  perOperation: z.array(CostBucketSchema),
  perTenant: z.array(CostBucketSchema),
  pricing: z.record(z.string(), PricingEntrySchema),
  source: z.literal('metrics'),
});

export type CostResponse = z.infer<typeof CostResponseSchema>;
export type CostBucket = z.infer<typeof CostBucketSchema>;
