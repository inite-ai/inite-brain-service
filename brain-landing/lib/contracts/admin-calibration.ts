import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/calibration.
 *
 * **Duplicate** of src/contracts/admin/calibration.schema.ts.
 */

const CalibrationMapSchema = z.object({
  thresholds: z.array(z.number()),
  values: z.array(z.number()),
  sampleCount: z.number(),
})

const ReliabilityBinSchema = z.object({
  lower: z.number(),
  upper: z.number(),
  midpoint: z.number(),
  n: z.number(),
  meanRaw: z.number(),
  meanCorrect: z.number(),
  meanCalibrated: z.number(),
})

const CurvePointSchema = z.object({
  raw: z.number(),
  calibrated: z.number(),
})

const CalibrationVersionSchema = z.object({
  version: z.number(),
  sampleCount: z.number(),
  bins: z.number(),
  createdAt: z.string().optional(),
})

export const CalibrationResponseSchema = z.object({
  disabled: z.boolean(),
  source: z.enum(['synthetic', 'persisted']),
  map: CalibrationMapSchema.nullable(),
  reliability: z.array(ReliabilityBinSchema),
  ece: z.number(),
  brier: z.number(),
  curve: z.array(CurvePointSchema),
  versions: z.array(CalibrationVersionSchema).optional(),
})

export type CalibrationResponse = z.infer<typeof CalibrationResponseSchema>
export type ReliabilityBin = z.infer<typeof ReliabilityBinSchema>
export type CurvePoint = z.infer<typeof CurvePointSchema>
export type CalibrationVersion = z.infer<typeof CalibrationVersionSchema>
