import { z } from 'zod';

/**
 * Wire contract for GET /v1/users/:userId/profile (rolling user profile
 * v1 — deterministic query-time assembly, USER_PROFILE_API_ENABLED,
 * default off → 404). Runtime parity with the service DTO types is
 * pinned by test/contracts-user-profile.unit-spec.ts.
 */

export const ProfileFactSchema = z.object({
  factId: z.string(),
  /** The fact's object verbatim — deterministic v1 renders, never rewrites. */
  statement: z.string(),
  /** ISO instant the fact became valid (bitemporal validity axis). */
  validFrom: z.string(),
  confidence: z.number(),
  /** Last independent corroboration (`corroboration.lastAt`), when any. */
  lastSeenAt: z.string().optional(),
  /** Typed-atom kind (`source.kind`, DERIVER_TYPED_ATOMS), when stamped. */
  kind: z.string().optional(),
});

export const ProfileSectionSchema = z.object({
  /** The grouping key: the fact predicate — an aspect slug in derived
   *  worlds, a vocabulary predicate for ingested facts. */
  aspect: z.string(),
  facts: z.array(ProfileFactSchema),
});

export const UserProfileResponseSchema = z.object({
  userId: z.string(),
  generatedAt: z.string(),
  /** Facts included after the per-aspect and global caps. */
  factCount: z.number().int(),
  sections: z.array(ProfileSectionSchema),
  /** One line per fact: `- [aspect] statement (as of YYYY-MM-DD)`. */
  profileText: z.string(),
});

export type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;
