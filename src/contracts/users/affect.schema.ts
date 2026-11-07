import { z } from 'zod';
import { ASSERTIONS } from '../../common/assertion';
import { CONSENT_BASES } from '../../affect/consent.service';

/**
 * Wire contracts for a person's emotional data and consents (#909 step 3):
 * GET/DELETE /v1/users/:userId/affect, POST …/affect/:id/contest,
 * GET/POST /v1/users/:userId/consents, DELETE …/consents/:purpose. Runtime
 * parity with the service types is pinned by
 * test/contracts-affect.unit-spec.ts.
 */

const InferredBySchema = z.object({
  recorder: z.string(),
  version: z.string().optional(),
  model: z.string().optional(),
  modality: z.string().optional(),
});

export const AffectFactSchema = z.object({
  factId: z.string(),
  aspect: z.string(),
  statement: z.string(),
  /** stated / inferred / hypothesis / confirmed (src/common/assertion.ts). */
  assertion: z.enum(ASSERTIONS),
  inferredBy: InferredBySchema.optional(),
  validFrom: z.string(),
  validUntil: z.string().optional(),
  retracted: z.boolean(),
});

export const AffectBeliefSchema = z.object({
  beliefId: z.string(),
  subject: z.string(),
  field: z.string(),
  statement: z.string(),
  assertion: z.literal('inferred'),
  validFrom: z.string(),
  status: z.string(),
});

/** How the person seemed to feel at a time, read from their exact words (0188). */
export const AffectObservationSchema = z.object({
  observationId: z.string(),
  observedAt: z.string(),
  /** −1 (very unpleasant) … +1 (very pleasant). */
  valence: z.number(),
  /** anger / disgust / fear / joy / sadness / surprise / neutral. */
  label: z.string(),
  /** What the feeling was about, when the words say. */
  target: z.string().optional(),
  quote: z.string(),
  episodeId: z.string(),
  confidence: z.number(),
  assertion: z.literal('inferred'),
  inferredBy: InferredBySchema,
});

export const AffectExportResponseSchema = z.object({
  userId: z.string(),
  facts: z.array(AffectFactSchema),
  beliefs: z.array(AffectBeliefSchema),
  observations: z.array(AffectObservationSchema),
});

export const AffectEraseResponseSchema = z.object({
  userId: z.string(),
  scope: z.enum(['all', 'inferred']),
  factsDeleted: z.number().int(),
  beliefsDeleted: z.number().int(),
  derivedDeleted: z.number().int(),
  observationsDeleted: z.number().int(),
});

export const AffectContestResponseSchema = z.object({
  contested: z.string(),
  erased: AffectEraseResponseSchema,
});

export const RecordConsentRequestSchema = z.object({
  /** Lowercase snake_case, e.g. `affect_inference`. */
  purpose: z.string(),
  basis: z.enum(CONSENT_BASES),
  /** The version of the notice the person was shown. */
  noticeVersion: z.string(),
});

export const ConsentResponseSchema = z.object({
  consentId: z.string(),
  userId: z.string(),
  purpose: z.string(),
  basis: z.enum(CONSENT_BASES),
  noticeVersion: z.string(),
  grantedAt: z.string(),
  revokedAt: z.string().optional(),
  active: z.boolean(),
});

export const ConsentListResponseSchema = z.object({
  consents: z.array(ConsentResponseSchema),
});

export const ConsentRevokeResponseSchema = z.object({
  purpose: z.string(),
  revoked: z.boolean(),
  /** What withdrawing erased, by kind (counts). */
  erased: z.record(z.string(), z.number()),
});
