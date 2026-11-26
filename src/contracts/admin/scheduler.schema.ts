import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/scheduler.
 *
 * Duplicated in brain-landing/lib/contracts/admin-scheduler.ts. See
 * leases.schema.ts for the rationale on duplication.
 *
 * This was the most-quoted drift case from the audit: backend returns
 * { cron, intervals, timeouts } but the frontend's local interface
 * only declared { cron }. The two array fields were silently ignored.
 * Wiring this through brings them into the contract.
 */

const CronEntrySchema = z.object({
  name: z.string(),
  cronTime: z.string(),
  lastFireAt: z.string().nullable(),
  nextFireAt: z.string().nullable(),
  running: z.boolean(),
});

export const SchedulerResponseSchema = z.object({
  cron: z.array(CronEntrySchema),
  intervals: z.array(z.string()),
  timeouts: z.array(z.string()),
});

export type SchedulerResponse = z.infer<typeof SchedulerResponseSchema>;
