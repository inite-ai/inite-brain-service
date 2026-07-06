import { z } from 'zod';

/** Wire contracts for the code-memory anchor sweep (/v1/admin/code-memory). */

export const AnchorRowSchema = z.object({
  anchor: z.string(),
  entityId: z.string(),
  factIds: z.array(z.string()),
});

export const AnchorsListResponseSchema = z.object({
  anchors: z.array(AnchorRowSchema),
});

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

export const ApplyVerdictsResponseSchema = z.object({
  reanchored: z.number().int().nonnegative(),
  invalidated: z.number().int().nonnegative(),
  factsRetracted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export type AnchorsListResponse = z.infer<typeof AnchorsListResponseSchema>;
export type AnchorVerdict = z.infer<typeof AnchorVerdictSchema>;
export type ApplyVerdictsResponse = z.infer<typeof ApplyVerdictsResponseSchema>;
