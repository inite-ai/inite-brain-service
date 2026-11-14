import { z } from 'zod';

/**
 * Wire mirror of ServerModelsNotice (src/ai/provider-failure.ts, #945):
 * what a response carries when the server's model provider refused part
 * of the work, or the tenant's plan does not include server-side models
 * (`platform_models_not_included`, #945 phase 2). Parity: test/contracts-server-models.unit-spec.ts.
 */
export const ServerModelsNoticeSchema = z.object({
  code: z.enum(['server_models_unavailable', 'platform_models_not_included']),
  /** Plain-language explanation plus the two ways around it (BYOK, harness mode). */
  message: z.string(),
});

/** What a degraded synthesize stage was: the answer's generator or its verifier. */
export const SYNTHESIS_DEGRADATIONS = ['generator', 'verifier'] as const;
