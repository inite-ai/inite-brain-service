import { Injectable } from '@nestjs/common';
import { grantIdOfCredential } from '../../contracts/source-plane/source-plane.schema';
import { decryptSecret } from '../credential-cipher';
import { SourceOAuthService } from './source-oauth.service';

/**
 * CredentialProvider — the one place a connection's stored `credential`
 * becomes the secret a connector is handed (raw-evidence-sources-2026-09
 * § 8.4: own client behind this seam, Nango or another broker later as
 * a second implementation). Three stored forms:
 *
 *   `oauth:<grant id>`   a connected account — a fresh access token,
 *                        refreshed by the grant when it is about to
 *                        expire; a revoked / broken grant is a named
 *                        run failure, never a silent empty credential;
 *   `enc:v1:…`           an operator secret encrypted at rest;
 *   anything else        a legacy clear value (pre-key rows).
 */
@Injectable()
export class CredentialProvider {
  constructor(private readonly oauth: SourceOAuthService) {}

  async resolve(companyId: string, credential: string | null | undefined): Promise<string | null> {
    if (typeof credential !== 'string' || credential.length === 0) return null;
    const grantId = grantIdOfCredential(credential);
    if (grantId) return this.oauth.accessToken(companyId, grantId);
    return decryptSecret(credential);
  }
}
