import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/dreams/runs/:runId/emits.
 *
 * Per-run dream-emit drill (identity_link / resolution / summary).
 * Emit row bodies are open records — kind-shape unions live in the
 * dreams service and would be a maintenance burden to mirror here.
 * We pin the envelope (runId + emits array) and let consumers read
 * the per-row shape contextually by kind.
 *
 * Duplicated in brain-landing/lib/contracts/admin-dreams-emits.ts.
 */

const OpenRecord = z.record(z.string(), z.unknown());

export const DreamsEmitsResponseSchema = z.object({
  runId: z.string(),
  emits: z.array(OpenRecord),
});

export type DreamsEmitsResponse = z.infer<typeof DreamsEmitsResponseSchema>;
