import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/overview.
 *
 * Mirrors AdminOverview from admin.service.ts. Duplicated in
 * brain-landing/lib/contracts/admin-overview.ts.
 */

const AdminTenantRowSchema = z.object({
  companyId: z.string(),
  entities: z.number(),
  factsActive: z.number(),
  factsRetracted: z.number(),
});

const AdminDeadLetterRowSchema = z.object({
  companyId: z.string(),
  id: z.string(),
  reason: z.string(),
  rejectedAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

const AdminForgottenRowSchema = z.object({
  companyId: z.string(),
  entityIdHash: z.string(),
  reason: z.string(),
  forgottenAt: z.string(),
  factsDeleted: z.number(),
  edgesDeleted: z.number(),
});

const AdminMetricsSchema = z.object({
  ingestFactsTotal: z.number(),
  ingestFactsByOutcome: z.record(z.string(), z.number()),
  searchCallsTotal: z.number(),
  dreamsRunsTotal: z.number(),
  dreamsEmittedByKind: z.record(z.string(), z.number()),
  retractsTotal: z.number(),
  forgetsTotal: z.number(),
  openaiCallsTotal: z.number(),
  openaiTokensTotal: z.number(),
});

export const OverviewResponseSchema = z.object({
  generatedAt: z.string(),
  health: z.object({ surrealdb: z.enum(['ok', 'unreachable']) }),
  totals: z.object({
    tenants: z.number(),
    entities: z.number(),
    factsActive: z.number(),
    factsRetracted: z.number(),
    deadLetterLast24h: z.number(),
    forgottenLast24h: z.number(),
  }),
  metrics: AdminMetricsSchema,
  tenants: z.array(AdminTenantRowSchema),
  recentDeadLetter: z.array(AdminDeadLetterRowSchema),
  recentForgotten: z.array(AdminForgottenRowSchema),
});

export type OverviewResponse = z.infer<typeof OverviewResponseSchema>;
export type AdminTenantRow = z.infer<typeof AdminTenantRowSchema>;
export type AdminDeadLetterRow = z.infer<typeof AdminDeadLetterRowSchema>;
export type AdminForgottenRow = z.infer<typeof AdminForgottenRowSchema>;
export type AdminMetrics = z.infer<typeof AdminMetricsSchema>;
export { AdminDeadLetterRowSchema, AdminForgottenRowSchema };
