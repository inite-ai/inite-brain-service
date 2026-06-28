import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyService } from './api-key.service';
import { JwksService } from './jwks.service';
import { ApiKeyRecord } from './api-key.types';

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * CredentialResolverService — turns a bearer token into an ApiKeyRecord.
 *
 * Owns the two-source credential policy (JWT via JWKS, falling back to
 * static BRAIN_API_KEYS) and the production hardening that disables the
 * static fallback when JWKS is configured. Extracted from ApiKeyGuard so
 * the guard is left with just HTTP plumbing (header parsing + scope
 * enforcement) and keeps its injected-dep list ≤3.
 */
@Injectable()
export class CredentialResolverService {
  private readonly logger = new Logger(CredentialResolverService.name);
  private readonly staticAllowed: boolean;

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly jwks: JwksService,
    config: ConfigService,
  ) {
    const env = config.get<string>('NODE_ENV', 'development');
    // In production with JWKS configured, static keys are off — operators
    // must issue tokens through the auth-service. Everywhere else (dev,
    // test, JWKS not configured) static keys are accepted as a fallback.
    this.staticAllowed = !(env === 'production' && this.jwks.enabled());
    if (!this.staticAllowed) {
      this.logger.log(
        'Static BRAIN_API_KEYS disabled in production with JWKS enabled — JWT only',
      );
    }
  }

  /**
   * Resolve a bearer token to an authenticated record, or null when no
   * source recognises it. Tries JWKS verification first (when the token
   * has JWT shape), then the static-key table when still allowed.
   */
  async resolve(token: string): Promise<ApiKeyRecord | null> {
    let record: ApiKeyRecord | null = null;
    if (this.jwks.enabled() && JWT_SHAPE.test(token)) {
      record = await this.jwks.verify(token);
    }
    if (!record && this.staticAllowed) {
      record = this.apiKeys.resolve(token);
    }
    return record;
  }
}
