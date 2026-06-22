import { z } from 'zod';
import { AdminDeadLetterRowSchema } from './overview.schema';

/**
 * Wire contract for GET /v1/admin/dlq.
 *
 * Row shape is shared with the overview slice — same AdminDeadLetterRow.
 * Duplicated in brain-landing/lib/contracts/admin-dlq.ts.
 */

export const DlqResponseSchema = z.object({
  rows: z.array(AdminDeadLetterRowSchema),
});

export type DlqResponse = z.infer<typeof DlqResponseSchema>;
