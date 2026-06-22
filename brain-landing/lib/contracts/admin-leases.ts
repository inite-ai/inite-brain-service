import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/leases.
 *
 * **Duplicate** of src/contracts/admin/leases.schema.ts (backend).
 * Next's tsconfig does not see ../src, and a shared dir + tsconfig
 * path-alias on both sides is more moving parts than the value of the
 * coupling. If you change one side, change the other — the unit test
 * test/contracts-admin-leases.unit-spec.ts in the backend will catch
 * the controller drifting from the schema, and the BFF proxy at
 * app/api/admin/proxy/[...path]/route.ts will return 502 if the
 * runtime payload drifts from this copy.
 */

const LeaderLeaseRowSchema = z.object({
  name: z.string(),
  leaderId: z.string(),
  leaseUntil: z.string(),
  heartbeatAt: z.string(),
  acquiredAt: z.string(),
  expired: z.boolean(),
  expiresInSeconds: z.number(),
})

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
})

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
})

export type LeasesResponse = z.infer<typeof LeasesResponseSchema>
export type LeaderLeaseRow = z.infer<typeof LeaderLeaseRowSchema>
export type ActiveClaimRow = z.infer<typeof ActiveClaimRowSchema>
