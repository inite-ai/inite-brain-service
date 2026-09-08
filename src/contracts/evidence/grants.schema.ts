import { z } from 'zod';

/**
 * Wire contracts for the evidence sharing surface (Brain v2.1 MM-4,
 * migration 0122 — EVIDENCE_GRANTS_API_ENABLED, default off → 404).
 *
 * A grant is an OWNERSHIP row, not a capability token: it says WHO may
 * hold an observation, while every serve of the bytes re-runs the
 * raw-read gateway's own ladder (0125). So these shapes carry no secret,
 * no URL and no expiry — 0122 defines exactly four grant fields
 * (assetId, ownerKind, ownerId, purpose) plus the timestamps, and the
 * only horizon a grant has is the ASSET's retention (`retainUntil`,
 * echoed on the grant response): retention tombstones the asset and
 * purges every grant row with it, so no grant can outlive its content.
 *
 * Runtime truth lives at the write seam (evidence-store.service.ts
 * addGrant / revokeGrant / liveGrants) and in the authorization ladder
 * (evidence-grant.service.ts); these schemas document the wire.
 */

/** Grantee kinds a CLIENT may name. 0122's column also allows 'system',
 *  which this surface refuses: a system grant is live forever and would
 *  pin content past every user's GDPR erasure, so system ownership stays
 *  a property the write seam stamps at registration. */
export const EVIDENCE_GRANTEE_KINDS = ['user', 'pack'] as const;

export const GrantEvidenceAccessRequestSchema = z.object({
  /** 'user' = an end-user handle (the 0055 per-user fence the raw-read
   *  gateway enforces); 'pack' = an installed domain pack's id. */
  ownerKind: z.enum(EVIDENCE_GRANTEE_KINDS),
  /** Opaque owner handle — never content, never validated for existence
   *  (a grant to an unknown handle is inert, and probing for one must
   *  not become a user-enumeration oracle). */
  ownerId: z.string().min(1).max(200),
  /** Short machine tag ('share', 'processor'…) — open vocabulary. */
  purpose: z.string().max(64).optional(),
});
export type GrantEvidenceAccessRequest = z.infer<typeof GrantEvidenceAccessRequestSchema>;

/** One LIVE (unrevoked) ownership row. Revoked rows are audit, not wire. */
export const EvidenceGrantRowSchema = z.object({
  grantId: z.string(),
  ownerKind: z.enum(['user', 'pack', 'system']),
  ownerId: z.string(),
  purpose: z.string().optional(),
  /** ISO instant the ownership started. */
  grantedAt: z.string(),
});
export type EvidenceGrantRow = z.infer<typeof EvidenceGrantRowSchema>;

export const GrantEvidenceAccessResponseSchema = z.object({
  grantId: z.string(),
  /** False when an identical LIVE grant already existed (idempotent
   *  re-share returns the standing row instead of a duplicate). */
  created: z.boolean(),
  assetId: z.string(),
  /** The asset's retention horizon (ISO) or null when it has none — the
   *  effective end of this grant: retention purges asset and grants
   *  together, and a grant over an asset already past it is refused. */
  retainUntil: z.string().nullable(),
});
export type GrantEvidenceAccessResponse = z.infer<typeof GrantEvidenceAccessResponseSchema>;

export const RevokeEvidenceGrantResponseSchema = z.object({
  grantId: z.string(),
  /** Always true — revocation is idempotent, and an already-revoked
   *  grant answers exactly like a freshly revoked one (its original
   *  revokedAt timestamp is kept for audit). */
  revoked: z.literal(true),
});
export type RevokeEvidenceGrantResponse = z.infer<typeof RevokeEvidenceGrantResponseSchema>;

export const EvidenceGrantsListResponseSchema = z.object({
  assetId: z.string(),
  /** Live owners only, and only for a caller that passed the ownership
   *  fence — grantee handles never reach a non-owner. */
  grants: z.array(EvidenceGrantRowSchema),
});
export type EvidenceGrantsListResponse = z.infer<typeof EvidenceGrantsListResponseSchema>;
