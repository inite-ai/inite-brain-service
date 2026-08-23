import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/jobs.
 *
 * Duplicated in brain-landing/lib/contracts/admin-jobs.ts. See
 * leases.schema.ts for the rationale on duplication.
 *
 * The frontend ad-hoc interface drifted through Phase J/K: payload /
 * cancelRequested / attempts / claimedBy / leaseUntil / heartbeatAt /
 * visibleAfter were added to JobRunRow but the panel's local type
 * lagged. G1 patched the interface; G2 turns the wire shape into the
 * single source of truth so the next field added on the backend
 * either reaches the panel or 502s loudly at the BFF.
 *
 * `status` and `triggeredBy` are real protocol enums — locked. The
 * payload / progress / result fields stay open records because their
 * shape is per-jobType and lives in the consumer (admin UI's JsonView
 * renders them generically anyway).
 */

const JobStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']);

const TriggeredBySchema = z.enum(['cron', 'manual', 'startup']);

const JobErrorSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
});

const OpenRecord = z.record(z.string(), z.unknown());

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
});

export const JobsListResponseSchema = z.object({
  jobs: z.array(JobRowSchema),
});

export type JobRow = z.infer<typeof JobRowSchema>;
export type JobsListResponse = z.infer<typeof JobsListResponseSchema>;
