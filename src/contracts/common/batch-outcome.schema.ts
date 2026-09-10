import { z } from 'zod';

/** Wire mirror of src/common/batch-outcome.ts (parity: test/batch-outcome.unit-spec.ts). */
export const BatchFailureSchema = z.object({
  /** The unit's retry key; `*` names the operation itself. */
  key: z.string(),
  error: z.string(),
});

export const BatchOutcomeSchema = z.object({
  /**
   * `complete` — every unit landed and every post-pass ran clean;
   * `degraded` — some units failed, or a post-pass over landed units
   * failed; `failed` — units were attempted and none succeeded, or the
   * operation could not run.
   */
  status: z.enum(['complete', 'degraded', 'failed']),
  total: z.number().int(),
  succeeded: z.number().int(),
  /** Units that failed — retryable via the entrypoint's `keys`. */
  failed: z.array(BatchFailureSchema),
  /** Post-pass / nested-batch failures that degrade without failing a unit. */
  degradedBy: z.array(BatchFailureSchema),
});
export type BatchOutcomeWire = z.infer<typeof BatchOutcomeSchema>;
