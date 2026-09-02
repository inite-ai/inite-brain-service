import { z } from 'zod';

/**
 * Wire contract for the raw-evidence read gateway (Brain v2.1 MM-3,
 * EVIDENCE_RAW_READ_ENABLED). Only the mint routes answer JSON — the
 * stream/redeem routes serve the blob itself (documented inline in
 * scripts/build-openapi.ts, no zod contract for a byte stream).
 */

/** Answer of GET /v1/evidence/{assetId}/raw-url and its fragment twin. */
export const EvidenceRawUrlResponseSchema = z.object({
  /** Opaque signed token — `base64url(payload) + '.' + hmac-sha256-hex`. */
  token: z.string(),
  /** Relative redeem path (`/v1/evidence/redeem/{token}`), servable by
   *  any host that fronts this API — no auth header needed. */
  url: z.string(),
  /** ISO instant after which the token redeems as 404. */
  expiresAt: z.string(),
});
export type EvidenceRawUrlResponse = z.infer<typeof EvidenceRawUrlResponseSchema>;
