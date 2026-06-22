import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/leases.
 *
 * Single source of truth between AdminJobsController.leases() (backend)
 * and brain-landing's LeasesPanel (frontend). The frontend ships an
 * identical copy at brain-landing/lib/contracts/admin-leases.ts —
 * duplicated rather than linked because next's tsconfig does not see
 * src/. If you change one side, change both, and the unit test
 * test/contracts-admin-leases.unit-spec.ts will catch the controller
 * drifting from this schema.
 *
 * Value enums (queueMode, jobType) describe shape, not allowed values.
 * registeredTypes / jobType are intentionally string-typed so backend
 * can add a new JobType without breaking the BFF parse at the boundary.
 */

const LeaderLeaseRowSchema = z.object({
  name: z.string(),
  leaderId: z.string(),
  leaseUntil: z.string(),
  heartbeatAt: z.string(),
  acquiredAt: z.string(),
  expired: z.boolean(),
  expiresInSeconds: z.number(),
});

const ActiveClaimRowSchema = z.object({
  runId: z.string(),
  jobType: z.string(),
  companyId: z.string(),
  claimedBy: z.string(),
  claimedAt: z.string(),
  leaseUntil: z.string(),
  heartbeatAt: z.string(),
  attempts: z.number(),
  leaseExpired: z.boolean(),
  leaseExpiresInSeconds: z.number(),
  lastHeartbeatSecondsAgo: z.number(),
});

export const LeasesResponseSchema = z.object({
  generatedAt: z.string(),
  podIdentity: z.string(),
  queueMode: z.enum(['enqueue', 'inline']),
  workerLoop: z.object({
    leader: z.boolean(),
    registeredTypes: z.array(z.string()),
  }),
  workerPool: z.object({
    enabled: z.boolean(),
    size: z.number(),
    idle: z.number(),
    busy: z.number(),
    waiters: z.number(),
  }),
  leaderLeases: z.array(LeaderLeaseRowSchema),
  activeClaims: z.array(ActiveClaimRowSchema),
});

export type LeasesResponse = z.infer<typeof LeasesResponseSchema>;
export type LeaderLeaseRow = z.infer<typeof LeaderLeaseRowSchema>;
export type ActiveClaimRow = z.infer<typeof ActiveClaimRowSchema>;
