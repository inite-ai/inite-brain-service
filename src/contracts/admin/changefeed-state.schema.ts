import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/changefeed/state.
 *
 * Duplicated in brain-landing/lib/contracts/admin-changefeed-state.ts.
 * See leases.schema.ts for the rationale on duplication.
 */

const ChangefeedStatsSchema = z.object({
  enabled: z.boolean(),
  inFlight: z.boolean(),
  lastTickAt: z.string().nullable(),
  lastPendingRemaining: z.number(),
  totalConsumed: z.number(),
  tickCount: z.number(),
  lastError: z.object({ message: z.string(), ts: z.string() }).nullable(),
  sources: z.array(z.string()),
  perBatchLimit: z.number(),
});

const ChangefeedCursorSchema = z.object({
  companyId: z.string(),
  source: z.string(),
  cursor: z.number(),
});

export const ChangefeedStateResponseSchema = z.object({
  stats: ChangefeedStatsSchema,
  cursors: z.array(ChangefeedCursorSchema),
});

export type ChangefeedStateResponse = z.infer<typeof ChangefeedStateResponseSchema>;
export type ChangefeedStats = z.infer<typeof ChangefeedStatsSchema>;
export type ChangefeedCursor = z.infer<typeof ChangefeedCursorSchema>;
