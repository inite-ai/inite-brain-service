import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/now.
 *
 * Mirrors ActivityTrackerService.list() + generatedAt envelope.
 * Duplicated in brain-landing/lib/contracts/admin-now.ts.
 */

const InFlightRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  path: z.string(),
  companyId: z.string().optional(),
  startedAtMs: z.number(),
});

export const NowResponseSchema = z.object({
  generatedAt: z.string(),
  inFlight: z.array(InFlightRequestSchema),
});

export type NowResponse = z.infer<typeof NowResponseSchema>;
