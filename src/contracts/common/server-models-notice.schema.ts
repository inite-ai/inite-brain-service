import { z } from 'zod';

/**
 * Wire mirror of ServerModelsNotice (src/ai/provider-failure.ts, #945):
 * what a response carries when the server's model provider refused part
 * of the work. Parity: test/contracts-server-models.unit-spec.ts.
 */
export const ServerModelsNoticeSchema = z.object({
  code: z.literal('server_models_unavailable'),
  /** Plain-language explanation plus the two ways around it (BYOK, harness mode). */
  message: z.string(),
});

/** What a degraded synthesize stage was: the answer's generator or its verifier. */
export const SYNTHESIS_DEGRADATIONS = ['generator', 'verifier'] as const;
