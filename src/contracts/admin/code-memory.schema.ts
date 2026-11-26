import { z } from 'zod';

/** Wire contracts for the code-memory anchor sweep (/v1/admin/code-memory). */

const AnchorRowSchema = z.object({
  anchor: z.string(),
  entityId: z.string(),
  factIds: z.array(z.string()),
});

export const AnchorsListResponseSchema = z.object({
  anchors: z.array(AnchorRowSchema),
});

/** @public the source of AnchorVerdict, read only as a type (z.infer). */
export const AnchorVerdictSchema = z.discriminatedUnion('action', [
  z.object({ anchor: z.string(), action: z.literal('ok') }),
  z.object({
    anchor: z.string(),
    action: z.literal('reanchor'),
    newAnchor: z.string(),
  }),
  z.object({
    anchor: z.string(),
    action: z.literal('invalidate'),
    reason: z.string().optional(),
  }),
]);

/** @public the source of ApplyVerdictsResponse, read only as a type (z.infer). */
export const ApplyVerdictsResponseSchema = z.object({
  reanchored: z.number().int().nonnegative(),
  invalidated: z.number().int().nonnegative(),
  factsRetracted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export type AnchorsListResponse = z.infer<typeof AnchorsListResponseSchema>;
export type AnchorVerdict = z.infer<typeof AnchorVerdictSchema>;
export type ApplyVerdictsResponse = z.infer<typeof ApplyVerdictsResponseSchema>;
