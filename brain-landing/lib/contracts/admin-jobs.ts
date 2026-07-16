import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/jobs.
 *
 * **Duplicate** of src/contracts/admin/jobs.schema.ts. See
 * admin-leases.ts for the rationale on duplication.
 */

const JobStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

/**
 * Canonical status list. Panels must derive their filter options from
 * this instead of hardcoding a copy (guarded by
 * __tests__/admin-drift.test.ts).
 */
export const JOB_STATUSES = JobStatusSchema.options

const TriggeredBySchema = z.enum(['cron', 'manual', 'startup'])

const JobErrorSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
})

const OpenRecord = z.record(z.string(), z.unknown())

export const JobRowSchema = z.object({
  runId: z.string(),
  jobType: z.string(),
  status: JobStatusSchema,
  triggeredBy: TriggeredBySchema,
  triggeredByActor: z.string().nullish(),
  startedAt: z.string(),
  finishedAt: z.string().nullish(),
  progress: OpenRecord.nullish(),
  payload: OpenRecord.nullish(),
  result: OpenRecord.nullish(),
  error: JobErrorSchema.nullish(),
  cancelRequested: z.boolean(),
  attempts: z.number().optional(),
  claimedBy: z.string().nullish(),
  claimedAt: z.string().nullish(),
  leaseUntil: z.string().nullish(),
  heartbeatAt: z.string().nullish(),
  visibleAfter: z.string().nullish(),
  companyId: z.string(),
})

export const JobsListResponseSchema = z.object({
  jobs: z.array(JobRowSchema),
})

export type JobRow = z.infer<typeof JobRowSchema>
export type JobsListResponse = z.infer<typeof JobsListResponseSchema>
