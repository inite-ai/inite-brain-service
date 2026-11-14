import { z } from 'zod';

/**
 * GET/PUT /v1/admin/model-source/:companyId (#945 phase 2): a tenant's
 * model-source setting and what it resolves to now. Parity:
 * test/model-source.unit-spec.ts.
 */
export const ModelSourceResponseSchema = z.object({
  companyId: z.string(),
  /** The stored setting; `platform` is granted only by the platform operator. */
  modelSource: z.enum(['auto', 'harness', 'platform']),
  /** Who serves this tenant's server-side chat calls right now. */
  source: z.enum(['platform', 'harness', 'byok', 'not_included']),
  reason: z.enum([
    'server_harness',
    'tenant_harness',
    'operator_platform',
    'gate_observe',
    'entitled',
    'not_entitled',
    'unknown_tenant',
    'no_tenant',
  ]),
  /** MODEL_PLATFORM_GATE: `observe` counts would-be refusals, `enforce` refuses. */
  gate: z.enum(['observe', 'enforce']),
  /** Whether a verified user credential's plan has been seen for this tenant. */
  entitlementsSeen: z.boolean(),
  /** Chat calls the gate would have refused in `observe`, since this process started. */
  observedRefusals: z.number().int().nonnegative(),
});
export type ModelSourceResponse = z.infer<typeof ModelSourceResponseSchema>;
