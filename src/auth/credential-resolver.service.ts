import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyService } from './api-key.service';
import { JwksService } from './jwks.service';
import { IntrospectionClient } from './introspection.client';
import { ApiKeyRecord } from './api-key.types';

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Opaque auth-service API keys are ik_-prefixed — see auth admin panel. */
const OPAQUE_KEY_PREFIX = 'ik_';

/**
 * CredentialResolverService — turns a bearer token into an ApiKeyRecord.
 *
 * Owns the three-source credential policy:
 *   1. JWT-shaped tokens → JWKS verification (auth-service user/M2M tokens)
 *   2. ik_-prefixed opaque keys → RFC 7662 introspection at the
 *      auth-service (operator-issued long-lived API keys)
 *   3. static BRAIN_API_KEYS — dev fallback only
 * plus the production hardening that disables the static fallback when a
 * remote verifier is configured. Extracted from ApiKeyGuard so the guard
 * is left with just HTTP plumbing (header parsing + scope enforcement)
 * and keeps its injected-dep list ≤3; the introspection client is a plain
 * config-built helper, not a DI dependency, for the same reason.
 */
@Injectable()
export class CredentialResolverService {
  private readonly logger = new Logger(CredentialResolverService.name);
  private readonly staticAllowed: boolean;
  private readonly introspection: IntrospectionClient | null;

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly jwks: JwksService,
    config: ConfigService,
  ) {
    this.introspection = IntrospectionClient.fromConfig(config);
    const env = config.get<string>('NODE_ENV', 'development');
    // In production with a remote verifier configured (JWKS and/or
    // introspection), static keys are off — operators must issue
    // credentials through the auth-service. Everywhere else (dev, test,
    // nothing configured) static keys are accepted as a fallback.
    const remoteConfigured = this.jwks.enabled() || this.introspection !== null;
    this.staticAllowed = !(env === 'production' && remoteConfigured);
    if (!this.staticAllowed) {
      this.logger.log(
        'Static BRAIN_API_KEYS disabled in production with a remote verifier enabled',
      );
    }
    if (this.introspection) {
      this.logger.log('Opaque API-key introspection enabled (RFC 7662)');
    }
  }

  /**
   * Resolve a bearer token to an authenticated record, or null when no
   * source recognises it. JWT-shaped tokens go to JWKS verification,
   * ik_-prefixed keys to introspection, then the static-key table when
   * still allowed.
   */
  async resolve(token: string): Promise<ApiKeyRecord | null> {
    let record: ApiKeyRecord | null = null;
    if (this.jwks.enabled() && JWT_SHAPE.test(token)) {
      record = await this.jwks.verify(token);
    }
    if (!record && this.introspection && token.startsWith(OPAQUE_KEY_PREFIX)) {
      record = await this.introspection.resolve(token);
    }
    if (!record && this.staticAllowed) {
      record = this.apiKeys.resolve(token);
    }
    return record;
  }
}
