import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  EVIDENCE_GRANTEE_KINDS,
  type GrantEvidenceAccessRequest,
} from '../../contracts/evidence/grants.schema';

/**
 * Wire shape of POST /v1/evidence/{assetId}/grants
 * (EVIDENCE_GRANTS_API_ENABLED, default off → 404).
 *
 * Deliberately TINY, and the omissions are the contract:
 *
 *  - no `assetId` in the body — the asset is the path, so a request
 *    cannot name one subject and act on another;
 *  - no `byteHash` — the surface never resolves content identity to a
 *    row, which is what closes the dedup-probe leak 0122's write seam
 *    already refuses to open (registerAsset's bare 409);
 *  - no `ownerKind: 'system'` — a system grant never dies with a user,
 *    so a client could pin content past GDPR erasure with it; system
 *    ownership stays a write-seam property of registration;
 *  - no expiry field — 0122 has no grant-expiry column, and the global
 *    `forbidNonWhitelisted` pipe therefore rejects `expiresAt` with a
 *    400 rather than accepting a horizon nothing would enforce. The
 *    asset's own `retainUntil` IS the horizon (echoed on the response).
 */
export class GrantEvidenceAccessDto implements GrantEvidenceAccessRequest {
  @IsIn(EVIDENCE_GRANTEE_KINDS)
  ownerKind!: (typeof EVIDENCE_GRANTEE_KINDS)[number];

  /** Opaque grantee handle. Never checked for existence: a grant to an
   *  unknown user is inert, and answering differently would turn the
   *  route into a user-enumeration oracle. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  ownerId!: string;

  /** Short machine tag; the write seam caps it at 64 chars too. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  purpose?: string | undefined;
}
