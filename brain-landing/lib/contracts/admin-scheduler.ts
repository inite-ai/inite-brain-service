import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/scheduler.
 *
 * **Duplicate** of src/contracts/admin/scheduler.schema.ts. See
 * admin-leases.ts for the rationale on duplication.
 */

const CronEntrySchema = z.object({
  name: z.string(),
  cronTime: z.string(),
  lastFireAt: z.string().nullable(),
  nextFireAt: z.string().nullable(),
  running: z.boolean(),
})

export const SchedulerResponseSchema = z.object({
  cron: z.array(CronEntrySchema),
  intervals: z.array(z.string()),
  timeouts: z.array(z.string()),
})

export type SchedulerResponse = z.infer<typeof SchedulerResponseSchema>
type CronEntry = z.infer<typeof CronEntrySchema>
