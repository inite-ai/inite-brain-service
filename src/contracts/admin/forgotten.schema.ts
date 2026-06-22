import { z } from 'zod';
import { AdminForgottenRowSchema } from './overview.schema';

/**
 * Wire contract for GET /v1/admin/forgotten.
 *
 * Row shape is shared with the overview slice — same AdminForgottenRow.
 * Duplicated in brain-landing/lib/contracts/admin-forgotten.ts.
 */

export const ForgottenResponseSchema = z.object({
  rows: z.array(AdminForgottenRowSchema),
});

export type ForgottenResponse = z.infer<typeof ForgottenResponseSchema>;
