import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/mri (Memory Reliability Index) and
 * GET /v1/admin/mri/operating-point.
 *
 * Admin/ops surface — deliberately NOT in the platform OpenAPI document
 * (scripts/build-openapi.ts scopes that to the community API). The shape is
 * pinned here and drift-guarded by test/contracts-admin-mri.unit-spec.ts, the
 * same way the calibration cockpit is.
 *
 * Every dimension value is a real number/string or an honest sentinel
 * (`'pending-eval'` / `'unrecorded'`); the union is left open (number|string)
 * so both render without a discriminated branch.
 */

export const PolicyOperatingPointSchema = z.object({
  flags: z.array(z.string()),
  accuracyProxy: z.number().nullable(),
  ece: z.number().nullable(),
  latencyP50: z.number().nullable(),
  latencyP95: z.number().nullable(),
  // Renamed from `costPerQuery`: the value is an UPPER BOUND (all-AI tokens ÷
  // synthesize count), not the true per-answer cost — the token counters are not
  // separable by subsystem. The name says so to prevent misreading.
  costPerQueryUpperBound: z.number().nullable(),
  sampleCount: z.number(),
});

export const MriDimensionSchema = z.object({
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
  source: z.string(),
  asOf: z.string(),
  evalGated: z.boolean(),
  reason: z.string().optional(),
  kind: z.enum(['live', 'structural', 'pending']),
});

export const MriReportSchema = z.object({
  generatedAt: z.string(),
  dimensions: z.record(z.string(), MriDimensionSchema),
  operatingPoint: PolicyOperatingPointSchema,
});

export type MriReportContract = z.infer<typeof MriReportSchema>;
export type MriDimensionContract = z.infer<typeof MriDimensionSchema>;
export type PolicyOperatingPointContract = z.infer<typeof PolicyOperatingPointSchema>;
