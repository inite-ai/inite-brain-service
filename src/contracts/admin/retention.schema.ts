import { z } from 'zod';

/**
 * GET/PUT /v1/admin/retention: the tenant's rule for erasing a person after
 * a stretch without contact (migration 0201, UserRetentionService). Parity:
 * test/user-retention.unit-spec.ts.
 */
export const RetentionSetRequestSchema = z.strictObject({
  /** Days without a write after which a user is forgotten; null turns retention off. */
  userInactiveDays: z.number().int().min(30).max(3650).nullable(),
});

export const RetentionResponseSchema = z.object({
  companyId: z.string(),
  /** null = off (the default for every tenant). */
  userInactiveDays: z.number().int().nullable(),
  /** The window the family products run with (two years). */
  familyDefaultDays: z.number().int(),
});

export type RetentionResponse = z.infer<typeof RetentionResponseSchema>;
